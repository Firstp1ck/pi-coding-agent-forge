# Technical reference: Theme bundle for Pi

Advanced user setup, configuration, compatibility, security, and troubleshooting information.

[Back to the human-friendly README](README.md) · [Contributor and implementation guide](DEVELOPMENT.md)

Firstpick's custom theme bundle for the Pi coding agent.

## What it does

- Adds sixteen custom themes to Pi's theme discovery.
- Packages themes through `pi.themes: ["./themes"]` for npm installation.
- Includes dark and light terminal palettes based on Catppuccin, Dracula, Tokyo Night, Gruvbox, Nord, Rosé Pine, One Dark, Solarized, and Everforest, plus Matrix-inspired and dark crimson custom palettes.

## Included themes

- `catppuccin-latte`
- `catppuccin-mocha`
- `crimson-noir`
- `dracula`
- `everforest-dark`
- `gruvbox-dark`
- `gruvbox-light`
- `matrix`
- `nord`
- `one-dark`
- `rose-pine`
- `rose-pine-dawn`
- `solarized-dark`
- `solarized-light`
- `tokyo-night`
- `tokyo-night-storm`

## Install

```bash
pi install npm:@firstpick/pi-themes-bundle
```

For local testing from this repository root:

```bash
pi install ./pi-package-themes-bundle
```

## Configuration

No required configuration.

Select a theme in `/settings` or set it in `~/.pi/agent/settings.json`:

```json
{
  "theme": "tokyo-night"
}
```

This bundle adds themes only; it registers no commands or model tools.

## Compatibility

The bundled palettes work with Pi 1.2's stricter theme validation. After updating a local copy, run `/reload` or restart Pi to rediscover the themes.

Catppuccin Mocha and Matrix keep their background images in the updated Pi WebUI. Update WebUI together with this bundle to retain those backgrounds; the terminal palettes do not depend on WebUI.

## Example view

```text
/settings
Theme: tokyo-night
```
