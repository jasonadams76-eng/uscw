# USCW sound files

Everything here is optional. A sound with no file is simply silent, and while `sounds.json` is empty the watch page has no sound controls at all.

To add a sound: copy the file into this folder (mp3 or m4a works everywhere), then add one line to `sounds.json`, commit and push.

```json
{
  "cues": {
    "intro_music": "intro.mp3",
    "bell": "bell.mp3",
    "crowd_pop": "crowd-pop.mp3",
    "crowd_boo": "crowd-boo.mp3",
    "crowd_chant": "crowd-chant.mp3",
    "mat_slam": "mat-slam.mp3",
    "pin_count": "pin-count.mp3",
    "chair_shot": "chair-shot.mp3"
  },
  "entrances": {
    "<wrestler id>": "vic-venom-theme.mp3"
  },
  "defaultEntrance": "default-entrance.mp3"
}
```

- `cues` are the names in the show editor's sound dropdown.
- `entrances` maps a wrestler's id to their theme. A wrestler's id is the last part of their profile address (`#wrestler-<id>`).
- `defaultEntrance` plays for any wrestler without a theme of their own.
- Keep files short (entrance themes of 15 to 30 seconds are plenty) and only use music you have the right to use. These files are public on the website.
