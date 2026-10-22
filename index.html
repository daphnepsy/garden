---
title: daphne's digital garden
layout: landing
---

{% assign notes = site.notes | sort: 'updated', 'first' | reverse %}
{% assign folders = notes | group_by: 'folder' | sort: 'name' %}
<p class="garden-intro">a small collection of my notes and thoughts. inspired by the gardens of <a href="https://garden.carolynyoo.com/">many</a> <a href="https://nesslabs.com/mind-garden">others</a>.</p>

{% if notes.size == 0 %}
<p class="garden-empty">Nothing planted yet. Check back soon 🌱</p>
{% else %}
{% for folder in folders %}
{% if folder.name != '' %}<h3 class="garden-folder" id="{{ folder.name | slugify }}">{{ folder.name | replace: '/', ' / ' }}</h3>{% endif %}
<ul class="garden-list">
	{% for note in folder.items %}
	<li>
		<a href="{{ note.url | relative_url }}">{{ note.title }}</a>
		{% if note.updated %}<span class="note-date">{{ note.updated | date: '%b %Y' }}</span>{% endif %}
	</li>
	{% endfor %}
</ul>
{% endfor %}
{% endif %}
