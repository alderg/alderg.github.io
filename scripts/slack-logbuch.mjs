#!/usr/bin/env node
// Logbuch — fetch Slack access logs for one user via team.accessLogs and
// report the number of workdays logged in from a given IP range.
//
// Mirrors the client-side logic in slack.html, but pulls the data directly
// from the Slack admin API instead of a pasted CSV. The token stays local.
//
// Requires: Node 18+ (global fetch). A Slack user token with the `admin`
// scope (xoxp-...), and a workspace on a paid plan.
//
// Usage:
//   node slack-logbuch.mjs --user UQ5209A75 --token xoxp-... \
//     --from 1.1.2026 --to 31.12.2026 --days 240 \
//     --include "144. 178." --exclude "178.197." --label Obwalden \
//     [--out <file|folder>] [--verbose]
//
// --out writes the report as an HTML file (a folder gets an auto-generated
// name). Open it in Chrome and print to PDF.

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

// Parses --key value, --flag, and single-dash variants (-flag, -v). A token
// starting with '-' is a key; the next token is its value unless it is also a
// flag (then the key is a boolean true).
function parseArgs(argv)
{
	var args = {};

	for (var i = 0; i < argv.length; i++)
	{
		var a = argv[i];

		if (a.charAt(0) === '-')
		{
			var key = a.replace(/^-+/, '');
			var next = argv[i + 1];

			if (next == null || next.charAt(0) === '-')
			{
				args[key] = true;
			}
			else
			{
				args[key] = next;
				i++;
			}
		}
	}

	return args;
}

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

function getKeys(obj)
{
	var result = [];

	for (var key in obj)
	{
		result.push(key);
	}

	return result;
}

// Creates the parent directory of the given output path if it is missing.
async function ensureDir(filePath)
{
	var fs = await import('node:fs');
	var path = await import('node:path');
	var dir = path.dirname(filePath);

	if (dir && dir !== '.' && !fs.existsSync(dir))
	{
		fs.mkdirSync(dir, { recursive: true });
	}
}

function isoDate(date)
{
	var m = ('0' + (date.getMonth() + 1)).slice(-2);
	var d = ('0' + date.getDate()).slice(-2);

	return date.getFullYear() + '-' + m + '-' + d;
}

function sanitize(text)
{
	return String(text).replace(/[^a-zA-Z0-9._-]+/g, '-');
}

// Builds an auto-generated, filesystem-friendly report name for folder output,
// e.g. Logbuch-Obwalden-2026-01-01_2026-12-31.html
function reportFilename(label, from, to)
{
	return 'Logbuch-' + sanitize(label) + '-' +
		isoDate(from) + '_' + isoDate(to) + '.html';
}

function sleep(ms)
{
	return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// team.accessLogs is Tier 2 (~20 requests/min). Space requests to stay under
// the limit, and back off on HTTP 429 by honoring the Retry-After header.
var REQUEST_SPACING_MS = 3500;
var MAX_RATELIMIT_RETRIES = 10;

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
			console.error('  rate limited — waiting ' + wait + 's, then retrying ' +
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

// Pages through team.accessLogs and returns all login entries for the team.
// The API has no per-user filter, so this returns every user's logins and the
// caller filters client-side.
//
// The API also has no lower time bound (only `before`), but it returns entries
// newest-first. So once an entire page predates `fromEpoch` (the start of the
// requested window), no later page can hold an in-window login and we stop —
// this avoids paging through years of older history. A countable entry has its
// date_first inside the window, which forces date_last >= fromEpoch, so testing
// date_last < fromEpoch is safe whether Slack orders by date_first or date_last.
// Pass fromEpoch = null to disable early stopping and fetch every page.
async function fetchAccessLogs(token, before, fromEpoch)
{
	var logins = [];
	var page = 1;
	var pages = 1;

	do
	{
		var params = new URLSearchParams();
		params.set('count', '1000');
		params.set('page', String(page));

		if (before != null)
		{
			params.set('before', String(before));
		}

		var data = await accessLogsRequest(token, params);
		var pageLogins = data.logins || [];
		logins = logins.concat(pageLogins);
		pages = (data.paging && data.paging.pages) || 1;

		// Oldest last-access on this page — shows how far back we have paged.
		var oldestTs = null;

		for (var k = 0; k < pageLogins.length; k++)
		{
			var dl = pageLogins[k].date_last;

			if (dl != null && (oldestTs == null || dl < oldestTs))
			{
				oldestTs = dl;
			}
		}

		vlog('Fetched page ' + page + '/' + pages + ' (+' +
			pageLogins.length + ', ' + logins.length + ' entries so far' +
			(oldestTs != null ? ', oldest ' + dateString(new Date(oldestTs * 1000)) : '') +
			')');

		if (fromEpoch != null && pageLogins.length > 0 &&
			pageLogins.every(function (l) { return l.date_last < fromEpoch; }))
		{
			vlog('Page ' + page + ' is entirely older than --from; ' +
				'stopping early (pass --all-pages to disable).');
			break;
		}

		page++;

		if (page <= pages)
		{
			vlog('  pausing ' + (REQUEST_SPACING_MS / 1000) + 's (rate limit)');
			await sleep(REQUEST_SPACING_MS);
		}
	}
	while (page <= pages);

	return logins;
}

function explainError(error)
{
	var hints = {
		'not_authed': ' (no token provided)',
		'invalid_auth': ' (token is invalid or revoked)',
		'missing_scope': ' (token lacks the required `admin` scope)',
		'paid_only': ' (the workspace must be on a paid plan)',
		'ratelimited': ' (still rate limited after several retries — try again later)'
	};

	return hints[error] || '';
}

function buildReport(dates, title, label, days, start, end)
{
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
			logins += parseInt(entries[i].count);
			var agent = entries[i].user_agent;
			var ip = entries[i].ip;

			if (agents[agent] == null)
			{
				agents[agent] = true;
			}

			if (ips[ip] == null)
			{
				ips[ip] = true;
			}
		}

		var allIps = getKeys(ips);
		var ipLinks = [];

		for (var i = 0; i < allIps.length; i++)
		{
			ipLinks.push('<a href="https://ipwho.is/' + allIps[i] +
				'?output=csv&fields=ip,connection.isp">' + allIps[i] + '</a>');
		}

		total += 1;
		result += '<tr><td valign="top" align="center">' + total + '</td>' +
			'<td valign="top" align="center" style="white-space:nowrap;">' + key +
			'</td><td valign="top">' + getKeys(agents).join('<br>') +
			'</td><td align="center" valign="top">' + logins +
			'</td><td align="center" valign="top">' +
				ipLinks.join('<br>') + '</td></tr>';
	}

	result += '</tbody></table>';

	var pageTitle = title + ' draw.io AG ' + start + ' - ' + end;
	var perc = Math.round(total / days * 1000) / 10;
	var html = '<html><head><meta charset="UTF-8">' +
		'<title>' + pageTitle + '</title></head>' +
		'<body><h3 style="margin-bottom:6px;">' + pageTitle + '</h3>' +
		result + '<div style="margin-top:8px;">Total ' + label + ': ' + total +
		' von ' + days + ' Arbeitstagen (' + perc + '%)' + '</div></body></html>';

	return { html: html, total: total, perc: perc };
}

async function main()
{
	var args = parseArgs(process.argv.slice(2));
	var token = typeof args.token === 'string' ? args.token : null;
	var user = args.user;
	VERBOSE = !!(args.verbose || args.v);

	if (token == null || user == null)
	{
		console.error('Usage: node slack-logbuch.mjs --user <ID> --token <xoxp-...> ' +
			'[--from d.m.yyyy] [--to d.m.yyyy] [--days N] ' +
			'[--include "144. 178."] [--exclude "178.197."] [--label Obwalden] ' +
			'[--out <file|folder>] [--all-pages] [--verbose]');
		console.error('\n--user and --token are required.');
		process.exit(1);
	}

	var year = new Date().getFullYear();
	var from = parseDate(args.from || ('1.1.' + year));
	var to = parseDate(args.to || ('31.12.' + year));
	var days = parseInt(args.days || '240');
	var include = (args.include || '144. 178.').split(' ');
	var exclude = (args.exclude || '178.197.').split(' ');
	var label = args.label || 'Obwalden';
	var title = 'Logbuch';

	// Upper time bound for the API (end of the `to` day, in epoch seconds).
	var before = Math.floor((to.getTime() + 86400000) / 1000);
	// Start-of-window bound used to stop paging once we reach older history.
	var fromEpoch = args['all-pages'] ? null : Math.floor(from.getTime() / 1000);

	vlog('Configuration:');
	vlog('  user      = ' + user);
	vlog('  from      = ' + dateString(from));
	vlog('  to        = ' + dateString(to));
	vlog('  before    = ' + before + ' (' + new Date(before * 1000).toISOString() + ')');
	vlog('  days      = ' + days);
	vlog('  include   = ' + include.join(' '));
	vlog('  exclude   = ' + exclude.join(' '));
	vlog('  label     = ' + label);
	vlog('  early-stop= ' + (fromEpoch != null ? 'on (at --from)' : 'off (--all-pages)'));
	vlog('');

	console.error('Fetching workspace access logs from Slack' +
		(VERBOSE ? '' : ' (use --verbose for details)') + '...');

	var allLogins = await fetchAccessLogs(token, before, fromEpoch);
	var userLogins = allLogins.filter(function (l) { return l.user_id === user; });

	var dates = {};
	var start = null;
	var end = null;

	var matched = 0;
	var skippedRange = 0;
	var skippedIp = 0;

	for (var i = 0; i < userLogins.length; i++)
	{
		var login = userLogins[i];
		// date_first is a Unix timestamp in seconds.
		var ts = new Date(login.date_first * 1000);
		var date = dateString(ts);
		var d = parseDate(date);

		var inRange = d >= from && d <= to;
		var ipOk = isValidAddress(login.ip, include, exclude);

		if (inRange && ipOk)
		{
			matched++;
			vlog('  keep ' + date + '  ip=' + login.ip + '  count=' + login.count);
			end = date;

			if (start == null)
			{
				start = date;
			}

			if (dates[date] == null)
			{
				dates[date] = [];
			}

			dates[date].push(login);
		}
		else
		{
			if (!inRange) { skippedRange++; } else { skippedIp++; }
			vlog('  skip ' + date + '  ip=' + login.ip + '  (' +
				(!inRange ? 'out of range' : 'ip excluded') + ')');
		}
	}

	vlog('');
	vlog('Total entries fetched : ' + allLogins.length);
	vlog('Entries for user      : ' + userLogins.length);
	vlog('  kept (in range+ip)  : ' + matched);
	vlog('  skipped out of range: ' + skippedRange);
	vlog('  skipped ip excluded : ' + skippedIp);
	vlog('  distinct valid days : ' + getKeys(dates).length);
	vlog('');

	var report = buildReport(dates, title, label, days, start, end);

	console.log(label + ' ' + start + ' - ' + end + ': ' +
		report.total + ' of ' + days + ' workdays (' + report.perc + '%)');

	var outArg = args.out || args.output || args.o;

	if (outArg === true)
	{
		throw new Error('--out requires a path (a file or a folder)');
	}

	if (outArg)
	{
		var path = await import('node:path');
		var fs = await import('node:fs');
		var outPath;

		// Treat the argument as a folder if it has a trailing slash, no file
		// extension, or already exists as a directory; otherwise as a file.
		var looksLikeDir = /[\\/]$/.test(outArg) ||
			path.extname(outArg) === '' ||
			(fs.existsSync(outArg) && fs.statSync(outArg).isDirectory());

		if (looksLikeDir)
		{
			fs.mkdirSync(outArg, { recursive: true });
			outPath = path.join(outArg, reportFilename(label, from, to));
			vlog('Output folder: ' + outArg + ' -> ' + outPath);
		}
		else
		{
			await ensureDir(outArg);
			outPath = outArg;
		}

		fs.writeFileSync(outPath, report.html);
		console.error('Wrote HTML report to ' + outPath +
			'  (open in Chrome and print to PDF)');
	}
}

main().catch(function (e)
{
	console.error(e.message || e);
	process.exit(1);
});
