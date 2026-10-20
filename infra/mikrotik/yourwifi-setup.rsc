# YourWiFi: MikroTik RouterOS v7 hotspot baseline
#
# TEMPLATE. Have the network technician review every value before importing.
# It has NOT been tested on real hardware yet. Import on a router that has been reset
# without the default config:  /import yourwifi-setup.rsc
#
# Assumed topology:
#   ether1          -> Starlink router (in Bypass mode) or Starlink Ethernet adapter. WAN.
#   ether2..ether5  -> access points (bridged); customers get 10.5.50.0/24
#   wg-yourwifi     -> tunnel to the backend VPS (Starlink is behind CGNAT, so the
#                      router dials out; the backend reaches the REST API over this tunnel)
#
# Replace before import:
#   PORTAL_HOST            e.g. wifi.example.ng (serves the portal and /api)
#   VPS_PUBLIC_IP          public IP of the server running the API
#   VPS_WG_PUBLIC_KEY      WireGuard public key of the VPS
#   API_USER_PASSWORD      long random password for the backend's RouterOS user

:local portalHost "PORTAL_HOST"
:local vpsIp "VPS_PUBLIC_IP"
:local vpsKey "VPS_WG_PUBLIC_KEY"
:local apiPassword "API_USER_PASSWORD"

# ---------- WAN ----------
/ip dhcp-client add interface=ether1 disabled=no comment="WAN (Starlink)"

# ---------- Customer LAN ----------
/interface bridge add name=bridge-hotspot comment="Customer Wi-Fi"
/interface bridge port
add bridge=bridge-hotspot interface=ether2
add bridge=bridge-hotspot interface=ether3
add bridge=bridge-hotspot interface=ether4
add bridge=bridge-hotspot interface=ether5

/ip address add address=10.5.50.1/24 interface=bridge-hotspot
/ip pool add name=pool-hotspot ranges=10.5.50.10-10.5.50.250
/ip dhcp-server add name=dhcp-hotspot interface=bridge-hotspot address-pool=pool-hotspot lease-time=1h
/ip dhcp-server network add address=10.5.50.0/24 gateway=10.5.50.1 dns-server=10.5.50.1
/ip dns set allow-remote-requests=yes servers=1.1.1.1,8.8.8.8

/ip firewall nat add chain=srcnat out-interface=ether1 action=masquerade comment="Customer internet"

# ---------- Hotspot ----------
# http-pap is required: after payment the portal posts the voucher code to the router's login
# page. mac-cookie lets a device reconnect without retyping the code (revoked on expiry).
# Upload infra/mikrotik/hotspot/* to the router's "yourwifi" folder first (Files, or FTP/SFTP).
/ip hotspot profile add name=hsprof-yourwifi \
    hotspot-address=10.5.50.1 dns-name=login.yourwifi html-directory=yourwifi \
    login-by=http-pap,mac-cookie use-radius=no
/ip hotspot add name=hotspot1 interface=bridge-hotspot address-pool=pool-hotspot \
    profile=hsprof-yourwifi addresses-per-mac=1 disabled=no

# Walled garden: what customers can reach BEFORE paying.
# HTTP-level rules (by host) ...
/ip hotspot walled-garden
add dst-host=$portalHost comment="YourWiFi portal + API"
add dst-host=*.paystack.com comment="Paystack checkout"
add dst-host=*.paystack.co comment="Paystack API/JS"
# ... and IP-level rules, which HTTPS needs (the router can't see the host inside TLS).
/ip hotspot walled-garden ip
add action=accept dst-host=$portalHost comment="YourWiFi portal + API"
add action=accept dst-host=checkout.paystack.com comment="Paystack checkout"
add action=accept dst-host=js.paystack.co comment="Paystack JS"
add action=accept dst-host=api.paystack.co comment="Paystack API"
add action=accept dst-host=standard.paystack.co comment="Paystack checkout assets"
# Card payments also redirect to the issuing bank's 3-D Secure page, which varies by bank.
# Test real cards from your main banks on this network and add the hosts they need here.

# ---------- Backend tunnel (WireGuard) ----------
/interface wireguard add name=wg-yourwifi listen-port=13231 comment="Tunnel to YourWiFi backend"
/interface wireguard peers add interface=wg-yourwifi public-key=$vpsKey \
    endpoint-address=$vpsIp endpoint-port=51820 allowed-address=10.8.0.1/32 \
    persistent-keepalive=25s comment="YourWiFi VPS"
/ip address add address=10.8.0.2/24 interface=wg-yourwifi

# ---------- REST API for the backend ----------
# Least-privilege user that can only be reached over the tunnel.
/user group add name=yourwifi-api policy=read,write,api,rest-api,!local,!telnet,!ssh,!ftp,!reboot,!policy,!winbox,!web,!sniff,!sensitive,!romon,!test,!password
/user add name=yourwifi-api group=yourwifi-api password=$apiPassword address=10.8.0.1/32 comment="YourWiFi backend"

# REST is served by www-ssl. A self-signed cert is fine because traffic stays inside WireGuard
# (set MIKROTIK_INSECURE_TLS=true in the API's .env).
/certificate add name=yourwifi-rest common-name=10.8.0.2 days-valid=3650 key-usage=key-cert-sign,crl-sign,digital-signature,key-encipherment,tls-server
/certificate sign yourwifi-rest
/ip service set www-ssl disabled=no certificate=yourwifi-rest address=10.8.0.1/32
/ip service set www address=10.5.50.0/24
/ip service set api disabled=yes
/ip service set api-ssl disabled=yes
/ip service set telnet disabled=yes
/ip service set ftp disabled=yes

# ---------- Firewall (input) ----------
/ip firewall filter
add chain=input action=accept connection-state=established,related comment="established"
add chain=input action=drop connection-state=invalid
add chain=input action=accept protocol=icmp
add chain=input action=accept in-interface=wg-yourwifi protocol=tcp dst-port=443 src-address=10.8.0.1 comment="Backend -> REST"
add chain=input action=accept in-interface=ether1 protocol=udp dst-port=13231 comment="WireGuard"
add chain=input action=accept in-interface=bridge-hotspot comment="LAN (hotspot adds its own rules)"
add chain=input action=drop in-interface=ether1 comment="Drop everything else from WAN"

/system identity set name="YourWiFi-Router-1"
:put "Done. Next: upload hotspot files, configure APs, then run the go-live checklist in infra/README.md"
