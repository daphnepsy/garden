---
title: daphne's digital garden
layout: landing
---

{% assign notes = site.notes | sort: 'updated', 'first' | reverse %}
<p class="garden-intro">a small collection of my notes and thoughts. inspired by the gardens of <a href="https://garden.carolynyoo.com/">many</a> <a href="https://nesslabs.com/mind-garden">others</a>.</p>

{% if notes.size == 0 %}
<p class="garden-empty">Nothing planted yet. Check back soon 🌱</p>
{% else %}
<ul class="garden-list">
	{% for note in notes %}
	<li>
		<a href="{{ note.url | relative_url }}">{{ note.title }}</a>
		{% if note.updated %}<span class="note-date">{{ note.updated | date: '%b %Y' }}</span>{% endif %}
	</li>
	{% endfor %}
</ul>
{% endif %}
