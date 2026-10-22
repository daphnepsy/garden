---
title: Garden
layout: landing
---

{% assign notes = site.notes | sort: 'tended', 'first' | reverse %}
<p class="garden-intro">A small collection of notes and thoughts.</p>

{% if notes.size == 0 %}
<p class="garden-empty">Nothing planted yet. Check back soon 🌱</p>
{% else %}
<ul class="garden-list">
	{% for note in notes %}
	<li>
		<a href="{{ note.url | relative_url }}">{{ note.title }}</a>
		{% if note.tended %}<span class="note-date">{{ note.tended | date: '%b %Y' }}</span>{% endif %}
	</li>
	{% endfor %}
</ul>
{% endif %}
