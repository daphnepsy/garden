# Daphne's Garden

[garden.daphnepoon.com](https://garden.daphnepoon.com): notes I'm growing in public,
written in [Obsidian](https://obsidian.md) and published with Jekyll on GitHub Pages
(same look as [daphnepoon.com](https://daphnepoon.com)).

## Tending the garden

**Setup (once):** clone this repo, then in Obsidian choose *Open folder as vault*
and pick the repo folder. The shared settings in `.obsidian/` put new notes in
`_notes/`, pasted images in `assets/garden/`, and hide the site's code folders.
Use the *Obsidian Git* community plugin (or plain `git`) to commit and push.
Every push to `main` publishes the site within a minute or two.

**Writing a note:** create a note, then run *Templates: Insert template* →
*Garden note* to add its properties. Only notes with properties (front matter)
are published:

```yaml
---
title: Bread Baking
stage: seedling      # seedling 🌱, budding 🌿 or evergreen 🌳
planted: 2026-10-21  # when you started it
tended: 2026-10-21   # bump when you edit; the garden lists newest first
# published: false   # keep a draft off the site
---
```

Link notes the way you normally do in Obsidian: `[[Bread Baking]]`,
`[[Bread Baking|my bread notes]]`, `[[Bread Baking#Shaping]]`, and `![[loaf.png]]`
for images. A link to a note that doesn't exist yet shows up as faded text.
Each note lists the notes that link to it at the bottom.

The note's URL comes from its file name: `_notes/Bread Baking.md` →
`garden.daphnepoon.com/bread-baking`.

## Where things live

| What | Where |
| --- | --- |
| Notes | `_notes/*.md` |
| Images | `assets/garden/` |
| Note template | `_templates/Garden note.md` |
| Garden homepage | `index.md` |
| Obsidian link handling and backlinks | `_plugins/garden.rb` |
| Footer links, site title | `_config.yml` |

## Run it locally

```sh
bundle install
bundle exec jekyll serve
```

Then open http://localhost:4000.

The site is built and deployed by `.github/workflows/pages.yml` (GitHub's built-in
Pages build can't run the plugin in `_plugins/`), so in the repo's Settings → Pages,
"Source" must be set to **GitHub Actions**.
