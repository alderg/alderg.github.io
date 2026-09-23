#!/usr/bin/env node
// Logbuch — fetch one user's Slack access log for a year via team.accessLogs,
// save it as the same CSV that https://my.slack.com/account/logs exports, and
// print the Logbuch report of ../slack.html to PDF.
//
// The report is built from the CSV text with the same algorithm as slack.html,
// so a fetched log and an old CSV export (--csv) produce identical reports.
//
// Requires: Node 18+ (global fetch), Chrome/Chromium/Edge for the PDF, a
// Slack user token with the `admin` scope (xoxp-...) on a paid workspace.
//
// Usage:
//   node slack-logbuch.mjs              (current year, token from the Keychain)
//   SLACK_TOKEN=xoxp-... node slack-logbuch.mjs 2025
//   node slack-logbuch.mjs 2024 --csv slack-access-logs-2023-2024.csv
//   node slack-logbuch.mjs --from 1.1.2025 --to 30.6.2025 --days 120 \
//     --include "<prefix> <prefix>" --exclude "<prefix>" --label <place> --code <code>

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

// Keychain item the token is read from when SLACK_TOKEN is not set (macOS)
var KEYCHAIN_SERVICE = 'slack-logbuch';
var TITLE = 'Logbuch';
var CSV_HEADER = 'Date Accessed,User Agent - Simple,User Agent - Full,' +
	'IP Address,Number of Logins,Last Date Accessed';
var CHROME_PATHS = [
	'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
	'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
	'/Applications/Chromium.app/Contents/MacOS/Chromium',
	'/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];

// team.accessLogs is Tier 2 (~20 requests/min). Space requests to stay under
// the limit, and back off on HTTP 429 by honoring the Retry-After header.
var REQUEST_SPACING_MS = 3500;
var MAX_RATELIMIT_RETRIES = 10;
// Classic pagination stops at page 100 (100k entries per `before` window).
var MAX_PAGES = 100;

// Verbose tracing — toggled by --verbose. Goes to stderr so it never mixes
// with the result line on stdout.
var VERBOSE = false;

function vlog(msg)
{
	if (VERBOSE)
	{
		console.error(msg);
	}
}

// Parses --key value, --flag, single-dash variants (-flag, -v) and positional
// arguments (in args._). A token starting with '-' is a key; the next token is
// its value unless it is also a flag (then the key is a boolean true).
function parseArgs(argv)
{
	var args = { _: [] };

	for (var i = 0; i < argv.length; i++)
	{
		var a = argv[i];

		if (a.charAt(0) === '-' && a.length > 1)
		{
			var key = a.replace(/^-+/, '');
			var next = argv[i + 1];

			if (next == null || (next.charAt(0) === '-' && next.length > 1))
			{
				args[key] = true;
			}
			else
			{
				args[key] = next;
				i++;
			}
		}
		else
		{
			args._.push(a);
		}
	}

	return args;
}

// Progress on stderr: rewrites one line on a terminal, one line per update
// otherwise (and in --verbose mode, which prints lines in between).
var progressOpen = false;

function progress(msg, done)
{
	if (process.stderr.isTTY && !VERBOSE)
	{
		var width = process.stderr.columns || 100;
		process.stderr.write('\r\x1b[K' + msg.substring(0, width - 1) + (done ? '\n' : ''));
		progressOpen = !done;
	}
	else
	{
		console.error(msg);
	}
}

// Prints a status line, ending an open progress line first.
function status(msg)
{
	if (progressOpen)
	{
		process.stderr.write('\n');
		progressOpen = false;
	}

	console.error(msg);
}

function bar(frac)
{
	var n = Math.round(frac * 20);

	return '[' + '#'.repeat(n) + '-'.repeat(20 - n) + ']';
}

function formatDuration(seconds)
{
	seconds = Math.round(seconds);

	return (seconds >= 60) ? Math.floor(seconds / 60) + 'm' + pad(seconds % 60) + 's' : seconds + 's';
}

function sleep(ms)
{
	return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function pad(n)
{
	return ('0' + n).slice(-2);
}

function ymd(date)
{
	return date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate());
}

// ------------------------------------------------------------------ slack.html
// These functions are copied from slack.html and must stay in sync with it.

function dateString(date)
{
	return date.getDate() + '.' + (date.getMonth() + 1) +
		'.' + date.getFullYear();
}

function parseDate(text)
{
	var parts = text.split('.');

	return new Date(parts[1] + '/' + parts[0] + '/' + parts[2]);
}

function csvToArray(text)
{
	if (text.length > 0)
	{
		var p = '', row = [''], i = 0, s = !0, l;

		for (l of text)
		{
			if ('"' === l)
			{
				if (s && l === p)
				{
					row[i] += l;
				}

				s = !s;
			}
			else if (',' === l && s)
			{
				l = row[++i] = '';
			}
			else
			{
				row[i] += l;
			}

			p = l;
		}

		return row;
	}
	else
	{
		return [];
	}
}

function parseSlack(text)
{
	var logLines = text.split('\n').reverse();
	var slackByDate = {};
	var index = 1;

	while (index < logLines.length - 1)
	{
		var entry = csvToArray(logLines[index], ',');
		var date = dateString(new Date(entry[0]));

		if (slackByDate[date] == null)
		{
			slackByDate[date] = [];
		}

		slackByDate[date].push(entry);
		index += 1;
	}

	return slackByDate;
}

function getKeys(obj)
{
	var result = [];

	for (var key in obj)
	{
		result.push(key);
	}

	return result;
}

function isValidAddress(ip, includeTokens, excludeTokens)
{
	for (var i = 0; i < excludeTokens.length; i++)
	{
		if (ip.substring(0, excludeTokens[i].length) == excludeTokens[i])
		{
			return false;
		}
	}

	for (var i = 0; i < includeTokens.length; i++)
	{
		if (ip.substring(0, includeTokens[i].length) == includeTokens[i])
		{
			return true;
		}
	}

	return false;
}

// ---------------------------------------------------------------------- report

function escapeHtml(text)
{
	return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// process() from slack.html, taking the CSV text and options instead of
// reading form fields. Returns null if no entry matches.
function buildReport(csvText, from, to, include, exclude, days, label)
{
	// parseSlack() skips the first reversed line, which is the empty string
	// after the export's trailing newline
	csvText = csvText.replace(/\r/g, '').replace(/\n*$/, '\n');

	var logsByDate = parseSlack(csvText);
	var start = null;
	var end = null;
	var dates = {};

	for (var date in logsByDate)
	{
		var ts = parseDate(date);

		if (ts >= from && ts <= to)
		{
			var logs = logsByDate[date];

			for (var i = 0; i < logs.length; i++)
			{
				if (isValidAddress(logs[i][3], include, exclude))
				{
					end = date;

					if (start == null)
					{
						start = date;
					}

					if (dates[date] == null)
					{
						dates[date] = [];
					}

					dates[date].push(logs[i]);
				}
			}
		}
	}

	if (start == null)
	{
		return null;
	}

	var total = 0;
	var result = '<table border="1" cellpadding="3" style="font-size:small;border-collapse:collapse;" width="100%">' +
		'<thead><tr><td></td><td align="center">Date</td><td align="center">User Agents</td>' +
		'<td align="center">Logins</td><td align="center">IP Addresses</td></tr></thead><tbody>';

	for (var key in dates)
	{
		var entries = dates[key];
		var agents = {};
		var logins = 0;
		var ips = {};

		for (var i = 0; i < entries.length; i++)
		{
			logins += parseInt(entries[i][4]);
			agents[entries[i][2]] = true;
			ips[entries[i][3]] = true;
		}

		var allIps = getKeys(ips);
		var ipLinks = [];

		for (var i = 0; i < allIps.length; i++)
		{
			ipLinks.push('<a href="https://ipwho.is/' + escapeHtml(allIps[i]) +
				'?output=csv&fields=ip,connection.isp">' + escapeHtml(allIps[i]) + '</a>');
		}

		total += 1;
		result += '<tr><td valign="top" align="center">' + total + '</td>' +
			'<td valign="top" align="center" style="white-space:nowrap;">' + key +
			'</td><td valign="top">' + getKeys(agents).map(escapeHtml).join('<br>') +
			'</td><td align="center" valign="top">' + logins +
			'</td><td align="center" valign="top">' +
				ipLinks.join('<br>') + '</td></tr>';
	}

	result += '</tbody></table>';

	var pageTitle = TITLE + ' draw.io AG ' + start + ' - ' + end;
	var perc = Math.round(total / days * 1000) / 10;
	var html = '<html><head><meta charset="UTF-8">' +
		'<title>' + pageTitle + '</title>' +
		'<style>@page { size: A4; }</style></head>' +
		'<body><h3 style="margin-bottom:6px;">' + pageTitle + '</h3>' +
		result + '<div style="margin-top:8px;">Total ' + escapeHtml(label) + ': ' + total +
		' von ' + days + ' Arbeitstagen (' + perc + '%)' + '</div></body></html>';

	return {
		html: html,
		summary: label + ' ' + start + ' - ' + end + ': ' +
			total + ' of ' + days + ' workdays (' + perc + '%)'
	};
}

function findChrome(explicit)
{
	var candidates = explicit ? [explicit] : CHROME_PATHS;

	for (var i = 0; i < candidates.length; i++)
	{
		if (fs.existsSync(candidates[i]))
		{
			return candidates[i];
		}
	}

	throw new Error('Chrome/Chromium/Edge not found; pass --chrome <path> or use --html');
}

function fileSize(file)
{
	try
	{
		return fs.statSync(file).size;
	}
	catch (e)
	{
		return 0;
	}
}

// Prints the HTML like slack.html's "Print Report" → Save as PDF, without the
// browser's date/title/URL header and footer. Headless Chrome sometimes keeps
// running after writing the PDF, so this waits for the file to stop growing
// and then closes Chrome itself.
async function printPdf(chrome, html, pdfPath)
{
	var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-logbuch-'));
	var htmlPath = path.join(dir, 'report.html');
	var tmpPdf = path.join(dir, 'report.pdf');
	var child = null;
	var exited = false;

	try
	{
		fs.writeFileSync(htmlPath, html);
		child = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run',
			'--no-default-browser-check', '--no-pdf-header-footer',
			'--user-data-dir=' + path.join(dir, 'profile'),
			'--print-to-pdf=' + tmpPdf, 'file://' + htmlPath], { stdio: 'ignore' });

		child.on('exit', function () { exited = true; });
		child.on('error', function () { exited = true; });

		var lastSize = -1;
		var deadline = Date.now() + 120000;

		for (;;)
		{
			await sleep(500);
			var size = fileSize(tmpPdf);

			if (exited || (size > 0 && size == lastSize) || Date.now() > deadline)
			{
				break;
			}

			lastSize = size;
		}

		if (fileSize(tmpPdf) == 0)
		{
			throw new Error('Chrome did not write the PDF (' + chrome + ')');
		}

		fs.copyFileSync(tmpPdf, pdfPath);
	}
	finally
	{
		if (child != null && !exited)
		{
			child.kill();

			// Give Chrome time to let go of its profile before deleting it
			for (var i = 0; i < 20 && !exited; i++)
			{
				await sleep(250);
			}
		}

		try
		{
			fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
		}
		catch (e)
		{
			vlog('Could not remove ' + dir + ': ' + e.message);
		}
	}
}

// ----------------------------------------------------------------------- fetch

function keychainToken()
{
	try
	{
		return execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
			{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
	}
	catch (e)
	{
		return null;
	}
}

function explainError(error)
{
	var hints = {
		'not_authed': ' (no token provided)',
		'invalid_auth': ' (token is invalid or revoked)',
		'missing_scope': ' (token lacks the required `admin` scope)',
		'not_allowed_token_type': ' (use the xoxp- user token, not a bot token)',
		'paid_only': ' (the workspace must be on a paid plan)',
		'ratelimited': ' (still rate limited after several retries — try again later)'
	};

	return hints[error] || '';
}

// Performs one team.accessLogs request, retrying on rate limits.
async function accessLogsRequest(token, params)
{
	for (var attempt = 0; ; attempt++)
	{
		vlog('  POST team.accessLogs?' + params.toString());

		var res = await fetch('https://slack.com/api/team.accessLogs', {
			method: 'POST',
			headers: {
				'Authorization': 'Bearer ' + token,
				'Content-Type': 'application/x-www-form-urlencoded'
			},
			body: params.toString()
		});

		var data = {};

		// 429 responses may carry an empty or non-JSON body.
		try { data = await res.json(); } catch (e) { /* ignore */ }

		var limited = res.status === 429 || data.error === 'ratelimited';

		if (limited && attempt < MAX_RATELIMIT_RETRIES)
		{
			var header = parseInt(res.headers.get('retry-after'), 10);
			var wait = (isNaN(header) ? 30 : header) + 1;
			status('  rate limited — waiting ' + wait + 's, then retrying ' +
				'(attempt ' + (attempt + 1) + '/' + MAX_RATELIMIT_RETRIES + ')');
			await sleep(wait * 1000);
			continue;
		}

		if (!data.ok)
		{
			throw new Error('Slack API error: ' + data.error +
				explainError(data.error));
		}

		return data;
	}
}

// Returns the user ID the token belongs to, the default for --user.
async function tokenUser(token)
{
	var res = await fetch('https://slack.com/api/auth.test', {
		method: 'POST',
		headers: { 'Authorization': 'Bearer ' + token }
	});
	var data = await res.json();

	if (!data.ok)
	{
		throw new Error('Slack API error: ' + data.error + explainError(data.error));
	}

	return data.user_id;
}

// Returns the logins of `user` whose date_first is in [fromEpoch, toEpoch).
//
// The API has no per-user filter and only an upper time bound (`before`), and
// returns entries newest-first. So this pages back from toEpoch, keeps the
// user's entries, and stops at the first page that ends entirely before
// fromEpoch (a countable entry has date_last >= date_first >= fromEpoch). If
// the 100-page cap is hit first, paging restarts with `before` just below the
// oldest entry seen. Pass allPages to disable the early stop.
async function fetchAccessLogs(token, user, fromEpoch, toEpoch, allPages)
{
	var logins = [];
	var seen = {};
	var before = toEpoch - 1;
	var total = 0;
	var requests = 0;
	var startTime = Date.now();

	for (;;)
	{
		var page = 1;
		var pages = 1;
		var oldest = null;
		var done = false;

		for (;;)
		{
			var params = new URLSearchParams();
			params.set('count', '1000');
			params.set('page', String(page));
			params.set('before', String(before));

			var data = await accessLogsRequest(token, params);
			var pageLogins = data.logins || [];
			pages = (data.paging && data.paging.pages) || 1;
			total += pageLogins.length;
			requests++;

			for (var i = 0; i < pageLogins.length; i++)
			{
				var l = pageLogins[i];
				var key = [l.user_id, l.ip, l.user_agent, l.date_first].join('\t');
				oldest = (oldest == null) ? l.date_first : Math.min(oldest, l.date_first);

				if (l.user_id === user && seen[key] == null &&
					l.date_first >= fromEpoch && l.date_first < toEpoch)
				{
					seen[key] = true;
					logins.push(l);
				}
			}

			if (oldest != null)
			{
				// Entries come newest first, so the oldest one so far shows how
				// much of the period (up to today) has been covered
				var upper = Math.min(toEpoch, Date.now() / 1000);
				var frac = Math.max(0, Math.min(1, (upper - oldest) / (upper - fromEpoch)));
				var elapsed = (Date.now() - startTime) / 1000;
				var eta = (frac > 0.02 && frac < 1) ? ', ~' +
					formatDuration(elapsed / frac - elapsed) + ' left' : '';

				progress('Fetching ' + bar(frac) + ' ' + Math.round(frac * 100) + '%  back to ' +
					dateString(new Date(oldest * 1000)) + ', page ' + requests + ', ' +
					logins.length + ' entries' + eta);
			}

			if (pageLogins.length == 0 || (!allPages &&
				pageLogins.every(function (e) { return e.date_last < fromEpoch; })))
			{
				vlog('Page ' + page + ' is entirely older than --from; stopping ' +
					'(pass --all-pages to disable).');
				done = true;
				break;
			}

			if (page >= Math.min(pages, MAX_PAGES))
			{
				done = pages <= MAX_PAGES;
				break;
			}

			page++;
			await sleep(REQUEST_SPACING_MS);
		}

		if (done || oldest == null || oldest - 1 >= before)
		{
			break;
		}

		before = oldest - 1;
		vlog('Hit the ' + MAX_PAGES + '-page cap; continuing before ' + before);
		await sleep(REQUEST_SPACING_MS);
	}

	progress('Fetching ' + bar(1) + ' 100%  ' + requests + ' pages, ' + logins.length +
		' entries in ' + formatDuration((Date.now() - startTime) / 1000), true);
	vlog('Total entries fetched: ' + total);

	return logins;
}

// ------------------------------------------------------------------------- csv

// The API prepends client tags ("SlackWeb/0 ", "ApiApp/A02F47USGGM ") that the
// /account/logs export does not show.
function cleanAgent(ua)
{
	while (/^(SlackWeb|ApiApp)\/\S* /.test(ua))
	{
		ua = ua.substring(ua.indexOf(' ') + 1);
	}

	return ua;
}

// Best-effort equivalent of the export's "User Agent - Simple" column, which
// the API does not return. Not used by the report.
function simpleAgent(ua)
{
	if (ua.indexOf('com.tinyspeck.chatlyio.share/') == 0)
	{
		return 'Unbekannter Client';
	}
	else if (ua.indexOf('com.tinyspeck.chatlyio') == 0)
	{
		return (ua.indexOf('(iPad;') >= 0) ? 'iOS App (iPad)' : 'iOS App (iPhone)';
	}
	else if (ua.indexOf('slack/') == 0 && ua.indexOf('Android') >= 0)
	{
		return 'Android App';
	}
	else if (ua.indexOf('Slack_SSB') >= 0 || ua.indexOf('Electron') >= 0)
	{
		return (ua.indexOf('Windows') >= 0) ? 'Windows Desktop-App' :
			((ua.indexOf('Macintosh') >= 0) ? 'Mac Desktop-App' : 'Linux Desktop-App');
	}
	else if (ua.indexOf('Mozilla/') == 0)
	{
		return 'Slack Web-App';
	}

	return 'Unbekannter Client';
}

function csvField(value, quote)
{
	value = String(value);

	return (quote || /[",\n]/.test(value)) ? '"' + value.replace(/"/g, '""') + '"' : value;
}

// Same columns, order (newest first) and Date.toString() timestamps as the
// /account/logs export, which is generated by JavaScript in the browser.
function toCsv(logins)
{
	var sorted = logins.slice().sort(function (a, b) { return b.date_first - a.date_first; });
	var lines = [CSV_HEADER];

	for (var i = 0; i < sorted.length; i++)
	{
		var l = sorted[i];
		var ua = cleanAgent(l.user_agent);
		// The export always quotes the full user agent
		lines.push([csvField(new Date(l.date_first * 1000)), csvField(simpleAgent(ua)),
			csvField(ua, true), csvField(l.ip), csvField(l.count),
			csvField(new Date(l.date_last * 1000))].join(','));
	}

	return lines.join('\n') + '\n';
}

// ------------------------------------------------------------------------ main

function usage()
{
	console.error('Usage: node slack-logbuch.mjs [YEAR] [--csv <file>] [--token <xoxp-...>] ' +
		'[--user <ID>] [--from d.m.yyyy] [--to d.m.yyyy] [--days N] ' +
		'[--include "<prefixes>"] [--exclude "<prefixes>"] [--label <place>] [--code <code>] ' +
		'[--out <folder>] [--html] [--chrome <path>] [--tz <zone>] [--all-pages] [--verbose]');
}

async function main()
{
	var args = parseArgs(process.argv.slice(2));

	if (args.help || args.h)
	{
		usage();
		return;
	}

	VERBOSE = !!(args.verbose || args.v);
	// Days are counted in this time zone, like slack.html in a Swiss browser
	process.env.TZ = (typeof args.tz === 'string') ? args.tz : 'Europe/Zurich';

	var year = parseInt(args._[0] || args.year || new Date().getFullYear());
	var from = parseDate(args.from || ('1.1.' + year));
	var to = parseDate(args.to || ('31.12.' + year));
	var fullYear = args.from == null && args.to == null;
	var days = parseInt(args.days || '240');
	// Defaults as in the form fields of slack.html
	var label = args.label || 'Obwalden';
	var code = args.code || 'OW';
	var outDir = (typeof args.out === 'string') ? args.out :
		((typeof args.o === 'string') ? args.o : 'reports');
	// Empty fields in slack.html match every address; here an empty --exclude
	// excludes nothing and an empty --include includes everything
	var include = String(args.include || '144. 178.').split(' ').filter(Boolean);
	var exclude = String(args.exclude != null ? args.exclude : '178.197.').split(' ').filter(Boolean);

	if (include.length == 0)
	{
		include = [''];
	}

	if (isNaN(from) || isNaN(to) || isNaN(days))
	{
		usage();
		throw new Error('Invalid --from, --to or --days');
	}

	var period = fullYear ? String(year) : ymd(from) + '_' + ymd(to);
	var csvText;
	fs.mkdirSync(outDir, { recursive: true });

	if (typeof args.csv === 'string')
	{
		csvText = fs.readFileSync(args.csv, 'utf8');
		status('Using ' + args.csv);
	}
	else
	{
		var token = (typeof args.token === 'string') ? args.token :
			(process.env.SLACK_TOKEN || keychainToken());

		if (!token)
		{
			usage();
			throw new Error('No token: store it with `security add-generic-password -a "$USER" ' +
				'-s ' + KEYCHAIN_SERVICE + ' -w`, set SLACK_TOKEN, or pass --csv <file>.');
		}

		var fromEpoch = Math.floor(from.getTime() / 1000);
		var toEpoch = Math.floor(new Date(to.getFullYear(), to.getMonth(),
			to.getDate() + 1).getTime() / 1000);

		var user = (typeof args.user === 'string') ? args.user : await tokenUser(token);
		status('Fetching access logs for ' + user + ', ' + dateString(from) +
			' - ' + dateString(to) + ' (Slack allows ~20 requests/min, about 3 minutes per year)');
		var logins = await fetchAccessLogs(token, user, fromEpoch, toEpoch, !!args['all-pages']);
		csvText = toCsv(logins);

		var csvPath = path.join(outDir, 'slack-access-logs-' + period + '.csv');
		fs.writeFileSync(csvPath, csvText);
		status('Wrote ' + logins.length + ' entries to ' + csvPath);
	}

	var report = buildReport(csvText, from, to, include, exclude, days, label);

	if (report == null)
	{
		throw new Error('No log entries match the date range and IP filters.');
	}

	var base = path.join(outDir, ymd(new Date()) + '-' + TITLE + '-' + code + '-' + period);

	if (args.html)
	{
		fs.writeFileSync(base + '.html', report.html);
		status('Wrote ' + base + '.html');
	}
	else
	{
		status('Printing PDF...');
		await printPdf(findChrome(typeof args.chrome === 'string' ? args.chrome : null),
			report.html, base + '.pdf');
		status('Wrote ' + base + '.pdf');
	}

	console.log(report.summary);
}

main().catch(function (e)
{
	status(e.message || e);
	process.exit(1);
});
