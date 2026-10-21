---
title: Garden
layout: landing
---

{% assign notes = site.notes | sort: 'tended', 'first' | reverse %}
<p class="garden-intro">A small collection of notes I'm growing in public. Some are rough seedlings, some are settled evergreens, and they link to each other in no particular order.</p>

{% if notes.size == 0 %}
<p class="garden-empty">Nothing planted yet. Check back soon 🌱</p>
{% else %}
<ul class="garden-list">
	{% for note in notes %}
	<li>
		<a href="{{ note.url | relative_url }}">{{ note.title }}</a>
		{% include note-stage.html stage=note.stage %}
		{% if note.tended %}<span class="note-date">{{ note.tended | date: '%b %Y' }}</span>{% endif %}
	</li>
	{% endfor %}
</ul>
{% endif %}
