---
title: daphne's digital garden
layout: landing
---

{% assign notes = site.notes | sort: 'updated', 'first' | reverse %}
<p class="garden-intro">a small collection of my notes and thoughts. inspired by the gardens of [many](https://garden.carolynyoo.com/) [others](https://nesslabs.com/mind-garden?fbclid=IwZXh0bgNhZW0CMTEAAR0c0PaZTFfY_CE4U4Si9WQItuFYFXXp6_X6ygg2oTcdkoNRcc-2aIo-2z4_aem_HENluXzmnh6mIZN8vecO4Q).</p>

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
