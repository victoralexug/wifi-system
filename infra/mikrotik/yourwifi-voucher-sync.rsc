# YourWiFi: collect generated voucher codes (MikroTik RouterOS v7)
#
# Every 6 hours the router asks the YourWiFi API for voucher batches it doesn't have yet, imports
# them as hotspot users, and confirms. Only then do those codes go on sale. The router makes one
# outgoing HTTPS request, so this works behind Starlink without a tunnel or a constant connection.
# If the API can't be reached, nothing changes and the next run tries again.
#
# NOT yet tested on a real router. Try it on a virtual MikroTik (CHR) first.
#
# Before importing (/import yourwifi-voucher-sync.rsc):
#   API_HOST      the API's host, e.g. yourwifi.onrender.com
#   ROUTER_TOKEN  the same value as ROUTER_TOKEN in the API's environment
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

:put "Done. Run it now with: /system script run yourwifi-voucher-sync"
