# Check a website and log it

A session in act mode: it may do what the "Allowed actions" list below names, and nothing else.

1. Take the site's hostname from the item (the frame allows this one value). It must be a plain
   public hostname: letters, digits, dots and hyphens only, with a dot, not an IP address, not
   `localhost`, not an internal name. Anything else, or a path, port or query with it: report it as
   a finding and stop. Never use a URL from the item as it is: build `https://<host>/` yourself.
2. Check that the site answers: `curl -sS -o /dev/null -w '%{http_code} %{time_total}\n' https://<host>/`.
3. If it does not answer, wait two minutes and check once more (an allowed action).
4. Log what you found (an allowed action).

## Allowed actions

- Check the site once more, two minutes after the first check, with the same `curl` command.
- Append one line to `~/notes/site-incidents.md` (create the file if it is missing): the date and
  time, the hostname, the status code of each check. Nothing else goes into that file, and no other
  file is written.

End with:

- **Status**: up or down, the HTTP code and time of each check;
- **Logged**: the line you appended;
- **What I recommend**: one or two lines;
- **How sure**: high, medium or low, and why.
