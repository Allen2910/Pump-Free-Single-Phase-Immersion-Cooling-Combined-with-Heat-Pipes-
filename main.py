"""Compatibility entry point for the Wi-Fi dashboard.

Both ``python app.py`` and ``python main.py`` now start the same application.
Fan control is handled by the ESP32 LAN HTTP API; no COM port is opened.
"""

from app import app


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)
