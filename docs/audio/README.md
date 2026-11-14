# USCW sound files

Everything here is optional. A sound with no file is simply silent, and while `sounds.json` is empty the watch page has no sound controls at all.

To add a sound: copy the file into this folder (mp3 or m4a works everywhere), then add one line to `sounds.json`, commit and push.

```json
{
  "cues": {
    "intro_music": "intro.mp3",
    "bell": "bell.mp3",
    "crowd_pop": "crowd-pop.mp3",
    "count_1": "crowd-one.mp3",
    "count_2": "crowd-two.mp3",
    "count_3": "crowd-three.mp3",
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
- `count_1`, `count_2`, `count_3` are the crowd counting along with a pin: one short recording of the crowd yelling each number. Each plays the moment that number appears on screen (a kickout plays 1 and 2, a pinfall plays 1, 2 and 3). Optional `pin_count_1`, `pin_count_2` and `pin_count_3` replace them on a real pinfall if you want louder versions.
- `entrances` maps a wrestler to their theme, by ring name in lower case (for example `"hardbody harrison"`) or by id (the last part of their profile address, `#wrestler-<id>`). The id wins if both are listed. Use short clips of about 30 seconds with a fade-out.
- `defaultEntrance` plays for any wrestler without a theme of their own.
- Keep files short (entrance themes of 15 to 30 seconds are plenty) and only use music you have the right to use. These files are public on the website.
