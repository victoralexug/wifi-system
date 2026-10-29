# YourWiFi: collect generated voucher codes and report their usage (MikroTik RouterOS v7)
#
# Every 6 hours the router asks the YourWiFi API for voucher batches it doesn't have yet, imports
# them as hotspot users, and confirms. Only then do those codes go on sale. Every 15 minutes it
# reports each code's used time and data, and removes codes that have expired (a code lasts its
# plan's duration from purchase, used or not). The router only makes outgoing HTTPS requests, so this
# works behind Starlink without a tunnel or a constant connection. If the API can't be reached,
# nothing changes and the next run tries again.
#
# Collecting codes is tested on a virtual MikroTik (CHR 7.25). Usage reports are not yet tested
# with a real customer session.
#
# Before importing (/import yourwifi-voucher-sync.rsc), replace every place of:
#   API_HOST      the API's host, e.g. wifisystem.netlify.app
#   ROUTER_TOKEN  the same value as ROUTER_TOKEN in the API's environment
# To install a newer version over an old one, first remove the old scripts and schedulers:
#   /system script remove [find name~"^yourwifi"]
#   /system scheduler remove [find name~"^yourwifi"]
#
# The hotspot itself (server, login page, walled garden) is set up separately. Customers log in
# with the voucher code as both username and password.

/system script add name=yourwifi-voucher-sync policy=read,write,test source=":do {\
    \n  /tool fetch url=\"https://API_HOST/api/router/vouchers.rsc\" http-header-field=\"Authorization: Bearer ROUTER_TOKEN\" dst-path=\"yourwifi-vouchers.rsc\"\
    \n  :delay 2s\
    \n  /import file-name=\"yourwifi-vouchers.rsc\" verbose=no\
    \n  /file remove [find name=\"yourwifi-vouchers.rsc\"]\
    \n} on-error={ :log warning \"yourwifi: voucher sync failed\" }"

/system scheduler add name=yourwifi-voucher-sync interval=6h start-time=startup \
    on-event="/system script run yourwifi-voucher-sync" policy=read,write,test \
    comment="YourWiFi: collect new voucher codes"

# Every 15 minutes the router reports each code's used time and data, so customers can see what's
# left on their account page (sent in parts of 40 codes), then removes expired codes.
/system script add name=yourwifi-usage-report policy=read,write,test source=":do {\
    \n  :local url \"https://API_HOST/api/router/usage\"\
    \n  :local auth \"Authorization: Bearer ROUTER_TOKEN\"\
    \n  :local body \"\"\
    \n  :local n 0\
    \n  :foreach u in=[/ip hotspot user find where comment~\"^yourwifi\" and uptime>0s] do={\
    \n    :local e [/ip hotspot user get \$u]\
    \n    :set body (\$body . \"u,\" . (\$e->\"name\") . \",\" . (\$e->\"uptime\") . \",\" . ((\$e->\"bytes-in\") + (\$e->\"bytes-out\")) . \"\\n\")\
    \n    :set n (\$n + 1)\
    \n    :if (\$n = 40) do={\
    \n      /tool fetch url=\$url http-method=post http-header-field=\$auth http-data=\$body output=none\
    \n      :set body \"\"\
    \n      :set n 0\
    \n    }\
    \n  }\
    \n  :foreach a in=[/ip hotspot active find] do={\
    \n    :local e [/ip hotspot active get \$a]\
    \n    :set body (\$body . \"a,\" . (\$e->\"user\") . \",\" . (\$e->\"uptime\") . \",\" . ((\$e->\"bytes-in\") + (\$e->\"bytes-out\")) . \"\\n\")\
    \n    :set n (\$n + 1)\
    \n    :if (\$n = 40) do={\
    \n      /tool fetch url=\$url http-method=post http-header-field=\$auth http-data=\$body output=none\
    \n      :set body \"\"\
    \n      :set n 0\
    \n    }\
    \n  }\
    \n  /tool fetch url=\$url http-method=post http-header-field=\$auth http-data=\$body output=none\
    \n  /tool fetch url=\"https://API_HOST/api/router/expired.rsc\" http-header-field=\$auth dst-path=\"yourwifi-expired.rsc\"\
    \n  :delay 2s\
    \n  /import file-name=\"yourwifi-expired.rsc\" verbose=no\
    \n  /file remove [find name=\"yourwifi-expired.rsc\"]\
    \n} on-error={ :log warning \"yourwifi: usage report failed\" }"

/system scheduler add name=yourwifi-usage-report interval=15m start-time=startup \
    on-event="/system script run yourwifi-usage-report" policy=read,write,test \
    comment="YourWiFi: report voucher usage"

:put "Done. Run them now with: /system script run yourwifi-voucher-sync  and  /system script run yourwifi-usage-report"
