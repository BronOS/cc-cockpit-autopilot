---
model: sonnet
---
# Check a website

You investigate; you change nothing. Report back in this tab.

1. Take the site's hostname from the item (the frame allows this one value). It must be a plain
   public hostname: letters, digits, dots and hyphens only, with a dot, not an IP address, not
   `localhost`, not an internal name. Anything else, or a path, port or query with it: report it as
   a finding and stop. Never use a URL from the item as it is: build `https://<host>/` yourself.
2. Check that the site answers: `curl -sS -o /dev/null -w '%{http_code} %{time_total}\n' https://<host>/`.
3. Check the TLS certificate expiry: `curl -sSv https://<host>/ 2>&1 | grep -i 'expire date'`.
4. For a Jira item, read the ticket with `ccc jira show <key>` (its comments and screenshots too).

End with:

- **Status**: up or down, the HTTP code and time;
- **Certificate**: expiry date and days left;
- **What I recommend**: one or two lines;
- **How sure**: high, medium or low, and why.
