/** Runs only inside an isolated gateway namespace, never on the host. */
export const GATEWAY_RUNTIME = String.raw`#!/bin/sh
set -eu
root=/run/sentinel-gateway
mkdir -p "$root"
families="4 6"
[ ! -f "$root/families" ] || families=$(cat "$root/families")

ipv6_enabled() {
  [ -d /proc/sys/net/ipv6 ] || return 1
  # Check default as well: new tunnel interfaces must not enable unprotected IPv6.
  for setting in /proc/sys/net/ipv6/conf/*/disable_ipv6; do
    [ -r "$setting" ] && [ "$(cat "$setting")" = 1 ] || return 0
  done
  return 1
}

block() {
  iptables -C OUTPUT ! -o lo -j REJECT 2>/dev/null || iptables -I OUTPUT 1 ! -o lo -j REJECT || return 1
  if [ "$families" = "4 6" ]; then
    ip6tables -C OUTPUT ! -o lo -j REJECT 2>/dev/null || ip6tables -I OUTPUT 1 ! -o lo -j REJECT || return 1
  fi
}

healthy() {
  [ -f "$root/active/hash" ] || return 1
  case "$(cat "$root/active/mode")" in
    off) return 0 ;;
    wireguard) ip link show wg0 >/dev/null 2>&1 ;;
    *) [ -f "$root/client.pid" ] && kill -0 "$(cat "$root/client.pid")" 2>/dev/null && ! grep -q ') Z ' "/proc/$(cat "$root/client.pid")/stat" ;;
  esac
}

stop_client() {
  if [ -f "$root/client.pid" ]; then
    pid=$(cat "$root/client.pid")
    kill "$pid" 2>/dev/null || true
    n=0
    while kill -0 "$pid" 2>/dev/null && [ "$n" -lt 50 ]; do sleep 0.1; n=$((n + 1)); done
    kill -9 "$pid" 2>/dev/null || true
    rm -f "$root/client.pid"
  fi
  if ip link show wg0 >/dev/null 2>&1; then wg-quick down /etc/wireguard/wg0.conf >/dev/null 2>&1 || true; fi
  ip link del wg0 2>/dev/null || true
  ip link del tun0 2>/dev/null || true
  for family in $families; do
    ip -"$family" rule flush || return 1
    while ip -"$family" rule del pref 0 2>/dev/null; do :; done
    ip -"$family" rule restore < "$root/rules$family" || return 1
    ip -"$family" route flush table all || return 1
    ip -"$family" route restore < "$root/routes$family" || return 1
  done
  iptables -D OUTPUT ! -o lo -j REJECT 2>/dev/null || true
  iptables-restore < "$root/iptables" || return 1
  if [ "$families" = "4 6" ]; then
    ip6tables -D OUTPUT ! -o lo -j REJECT 2>/dev/null || true
    ip6tables-restore < "$root/ip6tables" || return 1
  fi
}

start_client() {
  config="$root/active"
  : > "$root/client.log" || return 1
  # The old tunnel's resolver is unusable while the next client connects.
  printf 'nameserver 127.0.0.11\n' > /etc/resolv.conf || return 1
  case "$(cat "$config/mode")" in
    off) ;;
    simple|subscription)
      "$config/sing-box" run -c "$config/config.json" > "$root/client.log" 2>&1 &
      echo $! > "$root/client.pid"
      n=0
      until ip link show tun0 >/dev/null 2>&1 && curl -fsS -H "Authorization: Bearer $(cat /etc/sentinel-gateway/secret)" "http://127.0.0.1:$(cat /etc/sentinel-gateway/port)/version" >/dev/null; do
        kill -0 "$(cat "$root/client.pid")" 2>/dev/null || return 1
        n=$((n + 1)); [ "$n" -lt 100 ] || return 1
        sleep 0.1
      done
      ;;
    wireguard)
      mkdir -p /etc/wireguard || return 1
      cp "$config/wg0.conf" /etc/wireguard/wg0.conf || return 1
      wg-quick up /etc/wireguard/wg0.conf >> "$root/client.log" 2>&1 || return 1
      if [ "$(cat "$config/kill-switch")" = true ]; then
        ip route del default 2>/dev/null || true
        if [ "$families" = "4 6" ]; then ip -6 route del default 2>/dev/null || true; fi
      fi
      ;;
    openvpn)
      mkdir -p /etc/openvpn/client || return 1
      cp "$config/client.ovpn" "$config/hook.sh" /etc/openvpn/client/ || return 1
      : > /etc/openvpn/client/pushed-dns.conf || return 1
      set -- openvpn --cd /etc/openvpn/client --config client.ovpn --verb 3 --script-security 2 --route-up "/bin/sh /etc/openvpn/client/hook.sh"
      if [ -f "$config/auth.txt" ]; then set -- "$@" --auth-user-pass "$config/auth.txt" --auth-nocache; fi
      "$@" > "$root/client.log" 2>&1 &
      echo $! > "$root/client.pid"
      n=0
      until grep -q 'Initialization Sequence Completed' "$root/client.log"; do
        kill -0 "$(cat "$root/client.pid")" 2>/dev/null || return 1
        grep -qi 'AUTH_FAILED\|Exiting due to fatal error' "$root/client.log" && return 1
        n=$((n + 1)); [ "$n" -lt 120 ] || return 1
        sleep 0.5
      done
      if [ ! -s "$config/resolv.conf" ]; then cp /etc/openvpn/client/pushed-dns.conf "$config/resolv.conf" || return 1; fi
      [ -s "$config/resolv.conf" ] || return 1
      ;;
    *) return 1 ;;
  esac
  cat "$config/resolv.conf" > /etc/resolv.conf || return 1
}

case "$1" in
  init|probe)
    step="checking gateway tools"
    trap 'result=$?; if [ "$result" -ne 0 ]; then echo "gateway init failed: $step (exit $result)" >&2; fi' EXIT
    families=4
    if ipv6_enabled; then families="4 6"; fi
    tools="ip iptables iptables-save iptables-restore curl timeout"
    if [ "$families" = "4 6" ]; then tools="$tools ip6tables ip6tables-save ip6tables-restore"; fi
    for tool in $tools; do
      command -v "$tool" >/dev/null || { echo "missing gateway tool: $tool" >&2; exit 1; }
    done
    rm -rf "$root"
    mkdir -p "$root"
    echo "$families" > "$root/families"
    step="creating TUN device"
    mkdir -p /dev/net
    [ -c /dev/net/tun ] || mknod /dev/net/tun c 10 200
    for family in $families; do
      step="saving IPv$family routing rules"
      ip -"$family" rule save > "$root/rules$family"
      step="saving IPv$family routes"
      ip -"$family" route save table all > "$root/routes$family"
    done
    step="saving IPv4 firewall"
    iptables-save > "$root/iptables"
    if [ "$families" = "4 6" ]; then
      step="saving IPv6 firewall"
      ip6tables-save > "$root/ip6tables"
    fi
    step="blocking gateway output"
    block
    touch "$root/ready"
    trap - EXIT
    if [ "$1" = probe ]; then echo "gateway-ready: $families"; exit 0; fi
    # PID 1 keeps the namespace alive independently of the selected client.
    while :; do
      if [ ! -d "$root/switching" ] && [ -f "$root/active/hash" ] && ! healthy; then
        block
        rm -f "$root/active/hash"
      fi
      sleep 1 & wait $! || true
    done
    ;;
  status)
    healthy && cat "$root/active/hash"
    ;;
  apply)
    n=0
    until [ -f "$root/ready" ]; do n=$((n + 1)); [ "$n" -lt 50 ] || exit 2; sleep 0.1; done
    mkdir "$root/switching" || exit 3
    rm -f "$root/rolled-back"
    trap 'exit 2' HUP INT TERM
    trap 'result=$?; if [ "$result" -ne 0 ] && [ ! -f "$root/rolled-back" ]; then if block; then echo blocked >&2; else echo containment-failed >&2; fi; rm -f "$root/active/hash"; fi; rmdir "$root/switching"; exit "$result"' EXIT
    # The host pauses the work container before entering this transaction.
    rm -rf "$root/previous" "$root/next"
    cp -a /etc/sentinel-gateway/candidate "$root/next"
    stop_client
    [ ! -d "$root/active" ] || mv "$root/active" "$root/previous"
    mv "$root/next" "$root/active"
    if start_client; then exit 0; fi
    # Never echo credentials or the provider's full configuration in errors.
    stop_client
    rm -rf "$root/active"
    if [ -d "$root/previous" ]; then
      mv "$root/previous" "$root/active"
      if start_client; then touch "$root/rolled-back"; echo rollback >&2; exit 1; fi
    fi
    exit 2
    ;;
esac
`;
