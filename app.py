import os
import socket
import time
from datetime import datetime

import requests
from flask import Flask, jsonify, render_template, request


CHANNEL_ID = os.getenv("THINGSPEAK_CHANNEL_ID", "").strip()
READ_API_KEY = os.getenv("THINGSPEAK_READ_API_KEY", "").strip()
CACHE_SECONDS = 15

ESP32_BASE_URL = os.getenv("ESP32_BASE_URL", "").rstrip("/") or None
ESP32_DISCOVERY_PORT = int(os.getenv("ESP32_DISCOVERY_PORT", "4210"))
ESP32_DISCOVERY_TIMEOUT = float(os.getenv("ESP32_DISCOVERY_TIMEOUT", "1.0"))
ESP32_REQUEST_TIMEOUT = float(os.getenv("ESP32_REQUEST_TIMEOUT", "2.0"))
ESP32_DISCOVERY_MESSAGE = b"THERM_CORE_DISCOVER"
ESP32_DISCOVERY_REPLY = b"THERM_CORE:"
DEFAULT_FAN_SPEED = 50
DELTA_FAN_RATED_POWER_W = 14.8
INTERNAL_FAN_POWER_W = 0.48


def calculate_fan_power(external_fan_duty):
    return round(
        DELTA_FAN_RATED_POWER_W * float(external_fan_duty) / 100
        + INTERNAL_FAN_POWER_W,
        2,
    )


def calculate_pue(fan_power_w):
    return (100.0 + float(fan_power_w)) / 100.0

app = Flask(__name__)

current_metrics = {
    "temperature": None,
    "pue": calculate_pue(calculate_fan_power(DEFAULT_FAN_SPEED)),
    "internal_fan_duty": 100,
    "external_fan_duty": DEFAULT_FAN_SPEED,
    "fan_speed_setting": DEFAULT_FAN_SPEED,
    "fan_enabled": True,
    "chip_power_w": 100.0,
    "fan_power_w": calculate_fan_power(DEFAULT_FAN_SPEED),
}

thingspeak_cache = {"temperature": None, "timestamp": None, "fetched_at": 0.0}
esp32_cache = {"base_url": ESP32_BASE_URL, "discovered_at": 0.0}


class Esp32ConnectionError(RuntimeError):
    """Raised when the ESP32 cannot be discovered or reached over the LAN."""


def read_temperature_from_thingspeak():
    """Read field 1, using a short cache to stay within ThingSpeak limits."""
    if not CHANNEL_ID:
        raise ValueError("尚未設定 THINGSPEAK_CHANNEL_ID")

    now = time.monotonic()
    if (
        thingspeak_cache["temperature"] is not None
        and now - thingspeak_cache["fetched_at"] < CACHE_SECONDS
    ):
        return {
            "temperature": thingspeak_cache["temperature"],
            "timestamp": thingspeak_cache["timestamp"],
        }

    url = f"https://api.thingspeak.com/channels/{CHANNEL_ID}/fields/1/last.json"
    params = {"api_key": READ_API_KEY} if READ_API_KEY else {}
    response = requests.get(url, params=params, timeout=10)
    response.raise_for_status()
    result = response.json()
    field_value = result.get("field1")
    if field_value in (None, ""):
        raise ValueError("ThingSpeak field1 has no temperature value")

    thingspeak_cache.update(
        temperature=float(field_value),
        timestamp=result.get("created_at") or datetime.now().astimezone().isoformat(),
        fetched_at=now,
    )
    return {
        "temperature": thingspeak_cache["temperature"],
        "timestamp": thingspeak_cache["timestamp"],
    }


def discover_esp32(force=False):
    """Find THERM CORE on the local network using a small UDP broadcast."""
    if ESP32_BASE_URL:
        return ESP32_BASE_URL

    now = time.monotonic()
    if (
        not force
        and esp32_cache["base_url"]
        and now - esp32_cache["discovered_at"] < 60
    ):
        return esp32_cache["base_url"]

    udp_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        udp_socket.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        udp_socket.settimeout(ESP32_DISCOVERY_TIMEOUT)
        udp_socket.bind(("", 0))
        udp_socket.sendto(
            ESP32_DISCOVERY_MESSAGE,
            ("255.255.255.255", ESP32_DISCOVERY_PORT),
        )
        reply, sender = udp_socket.recvfrom(128)
    except (OSError, socket.timeout) as error:
        raise Esp32ConnectionError(
            "區域網路內找不到 ESP32；請確認電腦與 ESP32 使用相同 Wi-Fi"
        ) from error
    finally:
        udp_socket.close()

    if not reply.startswith(ESP32_DISCOVERY_REPLY):
        raise Esp32ConnectionError("收到無法辨識的 ESP32 探索回應")

    base_url = f"http://{sender[0]}"
    esp32_cache.update(base_url=base_url, discovered_at=now)
    return base_url


def request_esp32(method, path, data=None):
    """Call the ESP32 HTTP API and rediscover it once if its DHCP IP changed."""
    last_error = None
    for attempt in range(2):
        try:
            base_url = discover_esp32(force=attempt > 0)
            response = requests.request(
                method,
                f"{base_url}{path}",
                data=data,
                timeout=ESP32_REQUEST_TIMEOUT,
            )
            response.raise_for_status()
            result = response.json()
            if not result.get("ok", False):
                raise Esp32ConnectionError(result.get("message", "ESP32 拒絕控制指令"))
            result["device_url"] = base_url
            return result
        except (requests.RequestException, ValueError, TypeError) as error:
            last_error = error
            if ESP32_BASE_URL:
                break
            esp32_cache.update(base_url=None, discovered_at=0.0)

    target = ESP32_BASE_URL or "區域網路內的 ESP32"
    raise Esp32ConnectionError(f"無法連線至 {target}：{last_error}") from last_error


def read_fan_status():
    return request_esp32("GET", "/api/status")


def send_fan_control(speed_setting, enabled):
    return request_esp32(
        "POST",
        "/api/fan",
        data={
            "speed": speed_setting,
            "enabled": "1" if enabled else "0",
        },
    )


def update_fan_metrics(fan_state):
    speed_setting = round(float(fan_state["speed"]))
    enabled = bool(fan_state["enabled"])
    effective_speed = round(
        float(fan_state.get("effective_speed", speed_setting if enabled else 0))
    )
    fan_power_w = calculate_fan_power(effective_speed)
    current_metrics.update(
        pue=calculate_pue(fan_power_w),
        external_fan_duty=effective_speed,
        fan_speed_setting=speed_setting,
        fan_enabled=enabled,
        fan_power_w=fan_power_w,
    )


@app.route("/")
def home():
    return render_template("index.html")


@app.route("/api/status")
def status():
    fan_connected = False
    fan_address = ESP32_BASE_URL or esp32_cache["base_url"]
    try:
        fan_state = read_fan_status()
        update_fan_metrics(fan_state)
        fan_connected = True
        fan_address = fan_state["device_url"]
    except (Esp32ConnectionError, KeyError, ValueError, TypeError) as error:
        print(f"ESP32 network error: {error}")

    payload = {
        **current_metrics,
        "metrics_live": False,
        "fan_control_connected": fan_connected,
        "fan_control_transport": "wifi",
        "fan_control_address": fan_address,
    }
    try:
        latest = read_temperature_from_thingspeak()
        current_metrics["temperature"] = latest["temperature"]
        payload.update(
            temperature=latest["temperature"],
            temperature_live=True,
            timestamp=latest["timestamp"],
        )
        return jsonify(payload)
    except (requests.RequestException, ValueError, TypeError) as error:
        print(f"ThingSpeak read error: {error}")
        payload.update(
            temperature_live=False,
            timestamp=thingspeak_cache["timestamp"]
            or datetime.now().astimezone().isoformat(),
            message="目前無法取得 ThingSpeak 即時溫度",
        )
        if thingspeak_cache["temperature"] is not None:
            payload["temperature"] = thingspeak_cache["temperature"]
        return jsonify(payload), 200


@app.post("/api/fan")
def set_fan_speed():
    data = request.get_json(silent=True) or {}
    has_speed = "speed" in data
    has_enabled = "enabled" in data
    if not has_speed and not has_enabled:
        return jsonify(ok=False, message="請提供 speed 或 enabled"), 400

    speed_setting = current_metrics["fan_speed_setting"]
    enabled = current_metrics["fan_enabled"]

    if has_speed:
        speed = data["speed"]
        if isinstance(speed, bool) or not isinstance(speed, (int, float)):
            return jsonify(ok=False, message="speed 必須是 0 到 100 的數字"), 400

        speed = round(speed)
        if not 0 <= speed <= 100:
            return jsonify(ok=False, message="speed 必須介於 0 到 100"), 400

        # Keep the last non-zero setting. A zero-speed command is treated as off
        # so older clients do not accidentally erase the user's chosen speed.
        if speed == 0:
            enabled = False
        else:
            speed_setting = speed

    if has_enabled:
        if not isinstance(data["enabled"], bool):
            return jsonify(ok=False, message="enabled 必須是布林值"), 400
        enabled = data["enabled"]

    try:
        fan_state = send_fan_control(speed_setting, enabled)
        update_fan_metrics(fan_state)
    except (Esp32ConnectionError, KeyError, ValueError, TypeError) as error:
        return jsonify(
            ok=False,
            speed=speed_setting,
            enabled=enabled,
            effective_speed=speed_setting if enabled else 0,
            message=str(error),
        ), 503

    return jsonify(
        ok=True,
        speed=current_metrics["fan_speed_setting"],
        enabled=current_metrics["fan_enabled"],
        effective_speed=current_metrics["external_fan_duty"],
        connected=True,
        transport="wifi",
        device_url=fan_state["device_url"],
    )


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)
