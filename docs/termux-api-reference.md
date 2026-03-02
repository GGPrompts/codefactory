# Termux API Reference

Complete reference for the `termux-api` package, which exposes Android device APIs to the command line. Requires both the **Termux:API** companion app and the `termux-api` CLI package.

## Installation

```bash
# Install the CLI tools (also install Termux:API app from F-Droid)
pkg install termux-api
```

---

## Table of Contents

- [System & Device Info](#system--device-info)
- [Hardware Controls](#hardware-controls)
- [Sensors](#sensors)
- [Connectivity & Location](#connectivity--location)
- [Camera & Media](#camera--media)
- [Audio & Speech](#audio--speech)
- [Notifications & UI](#notifications--ui)
- [Clipboard & Text](#clipboard--text)
- [Communication (SMS, Calls, Contacts)](#communication-sms-calls-contacts)
- [Files & Sharing](#files--sharing)
- [Security & Authentication](#security--authentication)
- [Scheduling & System Management](#scheduling--system-management)
- [Infrared](#infrared)
- [Dashboard Potential Rankings](#dashboard-potential-rankings)

---

## System & Device Info

### termux-battery-status

Get the device battery status. No arguments required.

```bash
termux-battery-status
```

**JSON output:**
```json
{
  "health": "GOOD",
  "percentage": 67,
  "plugged": "PLUGGED_USB",
  "status": "CHARGING",
  "temperature": 28.6
}
```

| Field | Type | Description |
|-------|------|-------------|
| `health` | string | `GOOD`, `OVERHEAT`, `DEAD`, `OVER_VOLTAGE`, `UNKNOWN` |
| `percentage` | int | 0-100 charge level |
| `plugged` | string | `PLUGGED_AC`, `PLUGGED_USB`, `PLUGGED_WIRELESS`, `UNPLUGGED` |
| `status` | string | `CHARGING`, `DISCHARGING`, `FULL`, `NOT_CHARGING` |
| `temperature` | float | Battery temp in Celsius |

**Dashboard:** High value -- battery level, health, and charge state at a glance.

---

### termux-audio-info

Get information about audio capabilities of the device.

```bash
termux-audio-info
```

**JSON output:** Returns device audio properties including supported encodings, sample rates, and output capabilities.

---

### termux-telephony-deviceinfo

Get telephony hardware information.

```bash
termux-telephony-deviceinfo
```

**JSON output:**
```json
{
  "data_activity": "NONE",
  "data_state": "CONNECTED",
  "device_id": "...",
  "device_software_version": "01",
  "phone_count": 2,
  "phone_type": "GSM",
  "network_operator": "310260",
  "network_operator_name": "T-Mobile",
  "network_country_iso": "us",
  "network_type": "LTE",
  "network_roaming": false,
  "sim_country_iso": "us",
  "sim_operator": "310260",
  "sim_operator_name": "T-Mobile",
  "sim_serial_number": "...",
  "sim_state": "READY"
}
```

**Dashboard:** Moderate -- useful for network status monitoring.

---

### termux-telephony-cellinfo

Get cell tower information from all radios.

```bash
termux-telephony-cellinfo
```

**JSON output:** Returns array of cell info objects with signal strength, cell identity, timing advance, etc.

---

## Hardware Controls

### termux-brightness

Set screen brightness.

```bash
termux-brightness 128          # Set to ~50% (range: 0-255)
termux-brightness auto         # Restore auto-brightness
```

| Option | Description |
|--------|-------------|
| `0-255` | Brightness level |
| `auto` | Restore automatic brightness |

**Dashboard:** High value -- quick brightness slider.

---

### termux-torch

Toggle the LED flashlight.

```bash
termux-torch on
termux-torch off
```

**Dashboard:** High value -- instant flashlight toggle button.

---

### termux-vibrate

Vibrate the device.

```bash
termux-vibrate                 # Default: 1000ms
termux-vibrate -d 500          # Custom duration (ms)
termux-vibrate -f              # Force vibrate even in silent mode
```

| Option | Description |
|--------|-------------|
| `-d ms` | Duration in milliseconds (default: 1000) |
| `-f` | Force vibrate even in silent mode |

---

### termux-volume

View or change audio stream volumes.

```bash
termux-volume                  # Show all stream volumes (JSON)
termux-volume music 10         # Set music volume to 10
termux-volume ring 7           # Set ring volume to 7
```

**Valid streams:** `alarm`, `music`, `notification`, `ring`, `system`, `call`

**JSON output (no args):**
```json
[
  {"stream": "alarm", "volume": 6, "max_volume": 7},
  {"stream": "music", "volume": 10, "max_volume": 15},
  {"stream": "notification", "volume": 5, "max_volume": 7},
  {"stream": "ring", "volume": 5, "max_volume": 7},
  {"stream": "system", "volume": 7, "max_volume": 7},
  {"stream": "call", "volume": 4, "max_volume": 5}
]
```

**Dashboard:** High value -- volume sliders for each stream.

---

### termux-wallpaper

Change the device wallpaper.

```bash
termux-wallpaper -f ~/image.jpg        # From file
termux-wallpaper -u https://...        # From URL
termux-wallpaper -l -f ~/image.jpg     # Lock screen only
```

| Option | Description |
|--------|-------------|
| `-f file` | Set wallpaper from file |
| `-u url` | Set wallpaper from URL |
| `-l` | Set lock screen wallpaper |

---

## Sensors

### termux-sensor

Access device sensors (accelerometer, gyroscope, light, proximity, etc.).

```bash
termux-sensor -l                       # List all available sensors
termux-sensor -s "light" -n 1          # Read light sensor once
termux-sensor -s "accelerometer" -n 5 -d 1000  # 5 readings, 1s apart
termux-sensor -a -n 1                  # Read ALL sensors once
termux-sensor -c                       # Cleanup/release sensor resources
```

| Option | Description |
|--------|-------------|
| `-l` | List available sensors on this device |
| `-s sensors` | Comma-separated sensor names (partial match OK) |
| `-a` | Listen to all sensors (battery intensive) |
| `-d ms` | Delay between readings in milliseconds |
| `-n count` | Number of readings (default: continuous) |
| `-c` | Cleanup/release sensor listeners |

**JSON output:**
```json
{
  "sensors": [
    {
      "name": "BMI160 Accelerometer",
      "values": [0.0, 9.81, 0.0]
    }
  ]
}
```

**Dashboard:** High value -- live accelerometer, light level, proximity, ambient temp.

---

## Connectivity & Location

### termux-wifi-connectioninfo

Get info about the current WiFi connection.

```bash
termux-wifi-connectioninfo
```

**JSON output:**
```json
{
  "bssid": "aa:bb:cc:dd:ee:ff",
  "frequency_mhz": 5180,
  "ip": "192.168.1.42",
  "link_speed_mbps": 866,
  "mac_address": "02:00:00:00:00:00",
  "network_id": 1,
  "rssi": -45,
  "ssid": "MyNetwork",
  "ssid_hidden": false,
  "supplicant_state": "COMPLETED"
}
```

**Dashboard:** High value -- WiFi name, signal strength, IP address, link speed.

---

### termux-wifi-scaninfo

Get results from the last WiFi scan.

```bash
termux-wifi-scaninfo
```

**JSON output:** Returns array of nearby networks with SSID, BSSID, frequency, signal level, and capabilities.

---

### termux-wifi-enable

Toggle WiFi on or off.

```bash
termux-wifi-enable true
termux-wifi-enable false
```

**Dashboard:** High value -- WiFi toggle switch.

---

### termux-location

Get the device location.

```bash
termux-location                        # Default: GPS, once
termux-location -p network             # Use network provider (faster)
termux-location -p gps                 # Use GPS (more accurate, slower)
termux-location -r last                # Get last known location (instant)
termux-location -r updates             # Stream continuous updates
```

| Option | Description |
|--------|-------------|
| `-p provider` | `gps` (default), `network`, `passive` |
| `-r request` | `once` (default), `last`, `updates` |

**JSON output:**
```json
{
  "latitude": 37.7749,
  "longitude": -122.4194,
  "altitude": 10.0,
  "accuracy": 20.0,
  "vertical_accuracy": 2.0,
  "bearing": 0.0,
  "speed": 0.0,
  "elapsedMs": 42,
  "provider": "network"
}
```

**Note:** GPS requires clear sky. Network provider is faster but less accurate. Even network requests can take several seconds.

**Dashboard:** Moderate -- map view or coordinate display, but slow to acquire.

---

## Camera & Media

### termux-camera-info

Get information about device cameras.

```bash
termux-camera-info
```

**JSON output:** Returns array of camera objects with ID, facing direction, supported resolutions, focus modes, and white balance options.

---

### termux-camera-photo

Take a photo and save as JPEG.

```bash
termux-camera-photo ~/photo.jpg            # Default camera (rear)
termux-camera-photo -c 1 ~/selfie.jpg      # Front camera (ID 1)
```

| Option | Description |
|--------|-------------|
| `-c camera-id` | Camera ID from `termux-camera-info` (default: 0) |

**Dashboard:** Moderate -- snapshot button, but requires camera permission popup.

---

### termux-media-player

Control media playback.

```bash
termux-media-player play ~/music.mp3
termux-media-player pause
termux-media-player stop
termux-media-player info                   # Get current playback info
```

| Subcommand | Description |
|------------|-------------|
| `play file` | Play audio/video file |
| `pause` | Pause current playback |
| `stop` | Stop playback |
| `info` | Get playback status |

---

### termux-media-scan

Make file changes visible to Android media scanner (Gallery, etc.).

```bash
termux-media-scan ~/photo.jpg
termux-media-scan -r ~/Pictures           # Recursive scan
termux-media-scan -v ~/photo.jpg          # Verbose output
```

| Option | Description |
|--------|-------------|
| `-r` | Recursive directory scan |
| `-v` | Verbose output |

---

### termux-microphone-record

Record audio from the device microphone.

```bash
termux-microphone-record                   # Record with defaults
termux-microphone-record -f ~/audio.m4a    # Record to specific file
termux-microphone-record -l 30             # Limit to 30 seconds
termux-microphone-record -i               # Get recording info
termux-microphone-record -q               # Stop recording
```

| Option | Description |
|--------|-------------|
| `-d` | Start recording with defaults |
| `-f file` | Output file path |
| `-l seconds` | Recording time limit (0 = unlimited) |
| `-e encoder` | `aac` (default), `amr_wb`, `amr_nb` |
| `-b kbps` | Bitrate in kbps |
| `-r hz` | Sampling rate in Hz |
| `-c count` | Channel count (1 = mono, 2 = stereo) |
| `-i` | Get info about current recording |
| `-q` | Stop (quit) recording |

---

## Audio & Speech

### termux-tts-engines

List available text-to-speech engines.

```bash
termux-tts-engines
```

**JSON output:**
```json
[
  {
    "name": "com.google.android.tts",
    "label": "Google Text-to-speech Engine",
    "default": true
  }
]
```

---

### termux-tts-speak

Speak text aloud using a TTS engine.

```bash
termux-tts-speak "Hello world"
echo "Read this aloud" | termux-tts-speak
termux-tts-speak -r 1.5 -p 0.8 "Fast and low"
termux-tts-speak -e com.google.android.tts "Using Google TTS"
```

| Option | Description |
|--------|-------------|
| `-e engine` | TTS engine to use |
| `-l language` | Language code (e.g., `en`, `es`) |
| `-n region` | Region/country code |
| `-v variant` | Voice variant |
| `-p pitch` | Pitch multiplier (default: 1.0) |
| `-r rate` | Speech rate multiplier (default: 1.0) |
| `-s stream` | Audio stream: `ALARM`, `MUSIC`, `NOTIFICATION`, `RING`, `SYSTEM` |

**Dashboard:** High value -- text-to-speech button, read notifications aloud.

---

### termux-speech-to-text

Convert spoken audio to text via Android speech recognizer.

```bash
termux-speech-to-text
```

Sends partial recognition results to stdout as they arrive. Blocks until speech recognition is complete.

---

## Notifications & UI

### termux-notification

Display a system notification with extensive customization.

```bash
# Basic notification
termux-notification -t "Title" -c "Content text"

# With ID (for updating/removing later)
termux-notification --id mynotif -t "Download" -c "50% complete"

# With action buttons
termux-notification -t "Alert" -c "Something happened" \
  --button1 "Dismiss" --button1-action "termux-notification-remove mynotif" \
  --button2 "Open" --button2-action "termux-open-url https://example.com"

# Ongoing (pinned) notification
termux-notification --ongoing -t "Recording" -c "Mic is active"

# With vibration and LED
termux-notification -t "Urgent" -c "Check now" \
  --vibrate 200,400,200 --led-color FF0000 --priority max

# With image
termux-notification -t "Photo" --image-path ~/photo.jpg

# Media controls
termux-notification --type media -t "Now Playing" -c "Song Name" \
  --media-play --media-pause --media-next --media-previous

# From stdin
echo "Message body" | termux-notification -t "Piped"
```

| Option | Description |
|--------|-------------|
| `-t/--title` | Notification title |
| `-c/--content` | Notification content (overrides stdin) |
| `-i/--id` | Notification ID (for update/remove) |
| `--group` | Group name for bundling |
| `--priority` | `min`, `low`, `default`, `high`, `max` |
| `--ongoing` | Pin notification (persistent) |
| `--sound` | Play default notification sound |
| `--vibrate` | Vibration pattern (comma-separated ms) |
| `--led-color` | LED color in `RRGGBB` format |
| `--led-on` | LED on duration in ms (default: 800) |
| `--led-off` | LED off duration in ms (default: 800) |
| `--image-path` | Absolute path to image |
| `--action` | Command to run when notification tapped |
| `--on-delete` | Command to run when notification dismissed |
| `--button1/2/3` | Button label (up to 3 buttons) |
| `--button1/2/3-action` | Command for button tap |
| `--alert-once` | Only alert on first display |
| `--type media` | Enable media playback controls |

**Dashboard:** Very high value -- push notifications from dashboard, status alerts.

---

### termux-notification-remove

Remove a notification by ID.

```bash
termux-notification-remove mynotif
```

---

### termux-toast

Show a brief popup message (Android Toast).

```bash
termux-toast "Quick message"
termux-toast -g top "At the top"
termux-toast -b black -c yellow "Styled toast"
termux-toast -s "Short duration"
```

| Option | Description |
|--------|-------------|
| `-b color` | Background color (default: gray) |
| `-c color` | Text color (default: white) |
| `-g gravity` | Position: `top`, `middle` (default), `bottom` |
| `-s` | Short duration (default is longer) |

---

### termux-dialog

Show interactive dialogs for user input. Returns JSON.

```bash
# Text input (default)
termux-dialog

# Confirmation dialog
termux-dialog confirm -t "Are you sure?"

# Checkbox (multi-select)
termux-dialog checkbox -v "Option A,Option B,Option C" -t "Select items"

# Radio buttons (single-select)
termux-dialog radio -v "Red,Green,Blue" -t "Pick a color"

# Spinner dropdown
termux-dialog spinner -v "Small,Medium,Large" -t "Size"

# Bottom sheet
termux-dialog sheet -v "Edit,Delete,Share" -t "Actions"

# Number counter
termux-dialog counter -r "0,100,50" -t "Pick a number"

# Date picker
termux-dialog date -t "Select date" -d "dd-MM-yyyy"

# Time picker
termux-dialog time -t "Select time"

# Speech input
termux-dialog speech -t "Speak now"
```

| Widget | Required Options | Description |
|--------|-----------------|-------------|
| *(default)* | none | Text input field |
| `confirm` | none | Yes/No confirmation |
| `checkbox` | `-v values` | Multi-select checkboxes |
| `radio` | `-v values` | Single-select radio buttons |
| `spinner` | `-v values` | Dropdown single-select |
| `sheet` | `-v values` | Bottom sheet picker |
| `counter` | `-r min,max,start` | Number picker |
| `date` | none | Date picker |
| `time` | none | Time picker |
| `speech` | none | Voice input |

Common options: `-t title`, `-i hint` (input hint), `-m` (multi-line for text)

**JSON output (text input):**
```json
{
  "code": -1,
  "text": "user typed this"
}
```

**JSON output (checkbox):**
```json
{
  "code": -1,
  "text": "Option A",
  "values": [
    {"index": 0, "text": "Option A", "checked": true},
    {"index": 1, "text": "Option B", "checked": false}
  ]
}
```

**Dashboard:** High value -- interactive input for scripts and automations.

---

## Clipboard & Text

### termux-clipboard-get

Get the current system clipboard text.

```bash
termux-clipboard-get
```

Returns raw text (not JSON).

**Dashboard:** Moderate -- clipboard viewer/history.

---

### termux-clipboard-set

Set the system clipboard text.

```bash
termux-clipboard-set "Copied text"
echo "From pipe" | termux-clipboard-set
```

**Dashboard:** Moderate -- quick-copy buttons for common strings.

---

## Communication (SMS, Calls, Contacts)

### termux-sms-list

List SMS messages.

```bash
termux-sms-list                        # Default: 10 inbox messages
termux-sms-list -l 50                  # Last 50 messages
termux-sms-list -t sent               # Sent messages
termux-sms-list -n                     # Show phone numbers
termux-sms-list -o 10 -l 10           # Pagination: skip 10, show 10
```

| Option | Description |
|--------|-------------|
| `-d` | Show dates when messages were created |
| `-l limit` | Max number of messages (default: 10) |
| `-n` | Show phone numbers |
| `-o offset` | Offset for pagination |
| `-t type` | `inbox` (default), `sent`, `draft`, `outbox`, `all` |

**JSON output:**
```json
[
  {
    "threadid": 95,
    "type": "inbox",
    "read": true,
    "sender": "John",
    "number": "+15551234567",
    "received": "2025-06-18 19:17:38",
    "body": "Hey, are you coming?",
    "_id": 2453
  }
]
```

**Dashboard:** Moderate -- recent SMS viewer (requires SMS permission).

---

### termux-sms-send

Send an SMS message.

```bash
termux-sms-send -n "+15551234567" "Hello from Termux"
echo "Message body" | termux-sms-send -n "+15551234567"
```

| Option | Description |
|--------|-------------|
| `-n number` | Recipient phone number (required) |

---

### termux-contact-list

List all contacts.

```bash
termux-contact-list
```

**JSON output:**
```json
[
  {
    "name": "John Doe",
    "number": "+15551234567"
  }
]
```

---

### termux-call-log

List call log history.

```bash
termux-call-log                        # Default: 10 entries
termux-call-log -l 50                  # Last 50 calls
termux-call-log -o 20                  # Offset for pagination
```

| Option | Description |
|--------|-------------|
| `-l limit` | Number of entries (default: 10) |
| `-o offset` | Offset for pagination |

---

### termux-telephony-call

Initiate a phone call.

```bash
termux-telephony-call "+15551234567"
```

---

## Files & Sharing

### termux-share

Share content via Android share sheet.

```bash
termux-share ~/photo.jpg
echo "Share this text" | termux-share
termux-share --chooser ~/document.pdf
```

| Option | Description |
|--------|-------------|
| `--send` | Share for sending |
| `--view` | Share for viewing (default) |
| `--chooser` | Always show app chooser |
| `--content-type type` | MIME type override |

---

### termux-open

Open a file or URL in an external app.

```bash
termux-open ~/document.pdf
termux-open https://example.com
termux-open --chooser ~/image.png
```

| Option | Description |
|--------|-------------|
| `--send` | Open for sharing |
| `--view` | Open for viewing (default) |
| `--chooser` | Show app chooser |
| `--content-type type` | MIME type override |

---

### termux-open-url

Open a URL in the default browser.

```bash
termux-open-url "https://example.com"
```

---

### termux-download

Download a file using the Android system download manager.

```bash
termux-download "https://example.com/file.zip"
termux-download -t "My File" -d "Important download" "https://example.com/file.zip"
```

| Option | Description |
|--------|-------------|
| `-t title` | Notification title for the download |
| `-d description` | Notification description |

---

### termux-storage-get

Request a file from the Android system file picker.

```bash
termux-storage-get ~/output-file
```

Opens the system file picker; selected file is copied to the output path.

---

## Security & Authentication

### termux-fingerprint

Authenticate using the device fingerprint sensor (Android 6.0+).

```bash
termux-fingerprint
```

**JSON output (success):**
```json
{
  "auth_result": "AUTH_RESULT_SUCCESS"
}
```

**JSON output (failure):**
```json
{
  "auth_result": "AUTH_RESULT_FAILURE",
  "errors": "..."
}
```

**Dashboard:** High value -- biometric lock for sensitive dashboard actions.

---

### termux-keystore

Manage Android hardware-backed keystore.

```bash
termux-keystore list                          # List keys
termux-keystore generate "mykey" -a RSA -s 2048  # Generate key
termux-keystore sign "mykey" SHA256withRSA     # Sign data
termux-keystore delete "mykey"                # Delete key
```

| Subcommand | Description |
|------------|-------------|
| `list` | List all keys in the keystore |
| `generate name` | Generate a new key pair |
| `sign name algorithm` | Sign data from stdin |
| `delete name` | Delete a key |

---

## Scheduling & System Management

### termux-job-scheduler

Schedule scripts to run at specific times or intervals.

```bash
# Run script every 15 minutes
termux-job-scheduler --script ~/scripts/check.sh --period-ms 900000

# Run only when charging and on WiFi
termux-job-scheduler --script ~/scripts/sync.sh \
  --charging true --network unmetered

# List pending jobs
termux-job-scheduler --pending

# Cancel a job
termux-job-scheduler --cancel --job-id 1
```

| Option | Description |
|--------|-------------|
| `--script path` | Script to execute |
| `--job-id id` | Job identifier |
| `--pending` | List pending jobs |
| `--cancel` | Cancel a scheduled job |
| `--period-ms ms` | Repeat interval in milliseconds |
| `--network type` | Required network: `any`, `unmetered`, `cellular`, `not_roaming` |
| `--battery-not-low` | Only run when battery not low |
| `--storage-not-low` | Only run when storage not low |
| `--charging` | Only run when charging |

**Dashboard:** High value -- manage scheduled automations from dashboard UI.

---

### termux-wake-lock

Prevent the CPU from sleeping (keeps Termux processes running in background).

```bash
termux-wake-lock
```

**Dashboard:** Essential -- needed to keep dashboard backend alive.

---

### termux-wake-unlock

Release the wake lock, allowing the CPU to sleep normally.

```bash
termux-wake-unlock
```

---

### termux-reload-settings

Apply changes to Termux color, font, or terminal properties without restarting.

```bash
termux-reload-settings
```

---

### termux-setup-storage

Request storage permissions and create symlinks in `$HOME/storage/`.

```bash
termux-setup-storage
```

Creates: `~/storage/shared`, `~/storage/downloads`, `~/storage/dcim`, `~/storage/pictures`, `~/storage/music`, `~/storage/movies`.

---

### termux-fix-shebang

Rewrite script shebangs to use Termux paths.

```bash
termux-fix-shebang ~/scripts/myscript.sh
```

Changes `#!/usr/bin/env bash` to `#!/data/data/com.termux/files/usr/bin/env bash`, etc.

---

## Infrared

### termux-infrared-frequencies

Query supported IR carrier frequencies.

```bash
termux-infrared-frequencies
```

**JSON output:**
```json
[
  {"min": 30000, "max": 50000},
  {"min": 100000, "max": 200000}
]
```

---

### termux-infrared-transmit

Transmit an infrared pattern (for IR blaster-equipped devices).

```bash
termux-infrared-transmit -f 38000 100,200,100,200
```

| Option | Description |
|--------|-------------|
| `-f frequency` | Carrier frequency in Hz |
| Pattern | Comma-separated on/off durations in microseconds |

**Note:** Maximum transmission duration is 2 seconds.

**Dashboard:** Fun -- TV/AC remote control buttons.

---

## Complete Command Quick Reference

| Command | Category | Input | Output | Dashboard Value |
|---------|----------|-------|--------|-----------------|
| `termux-battery-status` | System | none | JSON | ***** |
| `termux-audio-info` | System | none | JSON | ** |
| `termux-telephony-deviceinfo` | System | none | JSON | *** |
| `termux-telephony-cellinfo` | System | none | JSON | ** |
| `termux-brightness` | Hardware | value | none | ***** |
| `termux-torch` | Hardware | on/off | none | ***** |
| `termux-vibrate` | Hardware | flags | none | *** |
| `termux-volume` | Hardware | stream+val | JSON | ***** |
| `termux-wallpaper` | Hardware | file/url | none | ** |
| `termux-sensor` | Sensors | flags | JSON | **** |
| `termux-wifi-connectioninfo` | Network | none | JSON | ***** |
| `termux-wifi-scaninfo` | Network | none | JSON | *** |
| `termux-wifi-enable` | Network | bool | none | **** |
| `termux-location` | Location | flags | JSON | *** |
| `termux-camera-info` | Camera | none | JSON | ** |
| `termux-camera-photo` | Camera | file | file | *** |
| `termux-media-player` | Media | subcmd | JSON | *** |
| `termux-media-scan` | Media | file | none | * |
| `termux-microphone-record` | Media | flags | file | ** |
| `termux-tts-engines` | Speech | none | JSON | * |
| `termux-tts-speak` | Speech | text | audio | **** |
| `termux-speech-to-text` | Speech | mic | text | *** |
| `termux-notification` | UI | flags | none | ***** |
| `termux-notification-remove` | UI | id | none | *** |
| `termux-toast` | UI | text | none | *** |
| `termux-dialog` | UI | widget | JSON | **** |
| `termux-clipboard-get` | Clipboard | none | text | *** |
| `termux-clipboard-set` | Clipboard | text | none | *** |
| `termux-sms-list` | Comms | flags | JSON | *** |
| `termux-sms-send` | Comms | text+num | none | *** |
| `termux-contact-list` | Comms | none | JSON | ** |
| `termux-call-log` | Comms | flags | JSON | ** |
| `termux-telephony-call` | Comms | number | none | * |
| `termux-share` | Files | file | none | ** |
| `termux-open` | Files | path/url | none | ** |
| `termux-open-url` | Files | url | none | ** |
| `termux-download` | Files | url | none | ** |
| `termux-storage-get` | Files | file | file | * |
| `termux-fingerprint` | Security | none | JSON | **** |
| `termux-keystore` | Security | subcmd | JSON | * |
| `termux-job-scheduler` | System | flags | none | **** |
| `termux-wake-lock` | System | none | none | ***** |
| `termux-wake-unlock` | System | none | none | *** |
| `termux-infrared-frequencies` | IR | none | JSON | ** |
| `termux-infrared-transmit` | IR | pattern | none | ** |

---

## Dashboard Potential Rankings

### Tier 1 -- Must-Have Dashboard Widgets

These return instant, useful data or provide high-value quick actions:

| Command | Why |
|---------|-----|
| `termux-battery-status` | Always-visible battery gauge with health/temp |
| `termux-wifi-connectioninfo` | Network name, signal, IP at a glance |
| `termux-volume` | Per-stream volume sliders |
| `termux-brightness` | Quick brightness slider |
| `termux-torch` | One-tap flashlight toggle |
| `termux-notification` | Push alerts from dashboard scripts |
| `termux-wake-lock` | Keep the dashboard backend alive |

### Tier 2 -- Very Useful Dashboard Features

| Command | Why |
|---------|-----|
| `termux-sensor` | Live light level, orientation, step counter |
| `termux-tts-speak` | Read text aloud from the dashboard |
| `termux-dialog` | Prompt user input from automations |
| `termux-fingerprint` | Biometric auth for sensitive actions |
| `termux-wifi-enable` | WiFi toggle switch |
| `termux-job-scheduler` | View/manage scheduled tasks |
| `termux-clipboard-get/set` | Clipboard viewer + quick-copy |

### Tier 3 -- Nice to Have

| Command | Why |
|---------|-----|
| `termux-location` | Map or coordinates (slow to acquire) |
| `termux-camera-photo` | Snapshot button |
| `termux-sms-list` | Recent messages viewer |
| `termux-sms-send` | Quick-send from dashboard |
| `termux-media-player` | Playback controls |
| `termux-speech-to-text` | Voice commands |
| `termux-toast` | Quick feedback popups |

### Tier 4 -- Situational

| Command | Why |
|---------|-----|
| `termux-infrared-transmit` | Only if device has IR blaster |
| `termux-telephony-*` | Network diagnostic info |
| `termux-contact-list` | Contact picker for SMS |
| `termux-call-log` | Historical data |
| `termux-wallpaper` | Fun but not essential |
| `termux-microphone-record` | Voice notes |

---

## Notes

- **Permissions:** Most commands require granting Android permissions the first time (location, contacts, SMS, camera, microphone, phone). The Termux:API app handles permission prompts.
- **JSON parsing:** Most read commands output JSON, making them easy to pipe into `jq` for filtering: `termux-battery-status | jq '.percentage'`
- **Background execution:** Use `termux-wake-lock` before running long-lived dashboard servers to prevent Android from killing the process.
- **Rate limiting:** Some commands (especially `termux-sensor` with `-a`) can drain battery quickly. Use `-n` and `-d` to limit sensor reads.
- **F-Droid vs Play Store:** The F-Droid version of Termux:API is recommended. The Play Store version is outdated and may not include newer commands.

## Sources

- [Termux API GitHub Repository](https://github.com/termux/termux-api)
- [All Termux API Commands Reference](https://github.com/123tool/All-Termux-API-Commands)
- [Termux Wiki](https://wiki.termux.com/wiki/Termux:API)
- [Termux API Usage Examples](https://github.com/gangadharKorrapati/termux-api-usage)
- [Termux Command Handbook](https://github.com/BlackTechX011/Termux-Command-Handbook)
