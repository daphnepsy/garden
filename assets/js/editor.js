// Garden editor (/editor/): edit notes in _notes/ through the GitHub API and
// preview them inside the real note layout (/editor/preview/).
//
// The preview follows the same rules as _plugins/garden.rb and the site's
// Markdown settings, so keep the two in step when either changes.

(function () {
	'use strict';

	const { repo, branch, baseurl, siteUrl } = window.GARDEN;
	const API = 'https://api.github.com/repos/' + repo;
	const RAW = 'https://raw.githubusercontent.com/' + repo + '/' + branch + '/';
	const TOKEN_KEY = 'garden-editor-token';
	const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif'];

	const $ = (id) => document.getElementById(id);
	const el = {
		signin: $('signin'), signinForm: $('signin-form'), token: $('token'), signinError: $('signin-error'),
		app: $('app'), picker: $('note-picker'), newNote: $('new-note'), status: $('status'),
		viewLive: $('view-live'), deleteNote: $('delete-note'), signOut: $('sign-out'), save: $('save'),
		title: $('title'), added: $('added'), updated: $('updated'), bump: $('bump'), draft: $('draft'),
		body: $('body'), fileName: $('file-name'), preview: $('preview'), panes: document.querySelector('.panes')
	};

	let token = null;
	let notes = [];        // [{ name, path }] from _notes/
	let current = null;    // { path, sha, frontMatter, savedText }
	let busy = false;

	// ---------- small helpers ----------

	function storage(action, value) {
		try {
			if (action === 'get') return localStorage.getItem(TOKEN_KEY);
			if (action === 'set') localStorage.setItem(TOKEN_KEY, value);
			if (action === 'clear') localStorage.removeItem(TOKEN_KEY);
		} catch (e) { /* private mode etc: the token just isn't remembered */ }
		return null;
	}

	function setStatus(text, kind) {
		el.status.textContent = text || '';
		el.status.className = 'status' + (kind ? ' ' + kind : '');
	}

	function today() {
		const d = new Date();
		return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
	}

	function formatDate(iso) {
		const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
		return m ? MONTHS[+m[2] - 1] + ' ' + (+m[3]) + ', ' + m[1] : '';
	}

	// Jekyll's default slugify, which gives a note its URL
	function slugify(name) {
		return name.replace(/[^\p{M}\p{L}\p{Nd}]+/gu, '-').replace(/^-|-$/g, '').toLowerCase();
	}

	function noteUrl(name) {
		return baseurl + '/' + slugify(name);
	}

	function baseName(path) {
		return path.split('/').pop().replace(/\.md$/, '');
	}

	function encodePath(path) {
		return path.split('/').map(encodeURIComponent).join('/');
	}

	function toBase64(text) {
		const bytes = new TextEncoder().encode(text);
		let binary = '';
		bytes.forEach((b) => { binary += String.fromCharCode(b); });
		return btoa(binary);
	}

	function fromBase64(b64) {
		const binary = atob(b64.replace(/\s/g, ''));
		return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
	}

	function fileToBase64(file) {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(String(reader.result).split(',')[1]);
			reader.onerror = () => reject(reader.error);
			reader.readAsDataURL(file);
		});
	}

	// ---------- GitHub ----------

	async function github(path, options) {
		const res = await fetch(API + path, Object.assign({
			cache: 'no-store',
			headers: {
				Accept: 'application/vnd.github+json',
				Authorization: 'Bearer ' + token,
				'X-GitHub-Api-Version': '2022-11-28'
			}
		}, options));
		if (res.status === 401) {
			signOut('GitHub didn’t accept the token (it may have expired). Paste a new one.');
			throw new Error('unauthorized');
		}
		const data = res.status === 204 ? null : await res.json().catch(() => null);
		if (!res.ok) {
			const error = new Error((data && data.message) || 'GitHub error ' + res.status);
			error.status = res.status;
			throw error;
		}
		return data;
	}

	function putFile(path, base64, message, sha) {
		const body = { message, content: base64, branch };
		if (sha) body.sha = sha;
		return github('/contents/' + encodePath(path), { method: 'PUT', body: JSON.stringify(body) });
	}

	// ---------- front matter ----------
	// Kept as raw lines so fields the editor doesn't know about are left alone.

	function splitNote(text) {
		const m = /^---\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/.exec(text);
		if (!m) return { frontMatter: [], body: text };
		return { frontMatter: m[1] ? m[1].split(/\r?\n/) : [], body: text.slice(m[0].length) };
	}

	function fieldIndex(lines, key) {
		return lines.findIndex((line) => line.startsWith(key + ':'));
	}

	function getField(lines, key) {
		const i = fieldIndex(lines, key);
		if (i < 0) return '';
		let value = lines[i].slice(key.length + 1).trim();
		if (value.startsWith('"')) {
			try { return JSON.parse(value); } catch (e) { return value.replace(/^"|"$/g, ''); }
		}
		if (value.startsWith('\'')) return value.replace(/^'|'$/g, '').replace(/''/g, '\'');
		return value;
	}

	// value === null removes the field (and anything nested under it)
	function setField(lines, key, value) {
		const out = lines.slice();
		let i = fieldIndex(out, key);
		if (i >= 0) {
			let end = i + 1;
			while (end < out.length && /^\s/.test(out[end])) end++;
			out.splice(i, end - i);
		} else {
			i = out.length;
		}
		if (value !== null) out.splice(i, 0, key + ': ' + value);
		return out;
	}

	function isoDate(value) {
		const m = /^(\d{4}-\d{2}-\d{2})/.exec(value || '');
		return m ? m[1] : '';
	}

	function composeNote() {
		let fm = current.frontMatter;
		fm = setField(fm, 'title', JSON.stringify(el.title.value.trim() || 'Untitled'));
		fm = setField(fm, 'added', el.added.value || null);
		fm = setField(fm, 'updated', el.updated.value || null);
		fm = setField(fm, 'published', el.draft.checked ? 'false' : null);
		return '---\n' + fm.join('\n') + '\n---\n' + el.body.value;
	}

	function isDirty() {
		return current && composeNote() !== current.savedText;
	}

	// ---------- Markdown, matching the site ----------

	const md = window.markdownit({ html: true, breaks: true, typographer: true });
	// kramdown turns -- / --- / ... into dashes and an ellipsis, but leaves (c) etc alone
	md.disable('replacements');
	md.core.ruler.push('kramdown_typography', (state) => {
		state.tokens.forEach((block) => {
			(block.children || []).forEach((t) => {
				if (t.type === 'text') t.content = t.content.replace(/---/g, '—').replace(/--/g, '–').replace(/\.\.\./g, '…');
			});
		});
	});

	const WIKILINK = /(!?)\[\[([^[\]]+?)\]\]/g;
	const CODE = /(^```[\s\S]*?^```|^~~~[\s\S]*?^~~~|`[^`\n]+`)/m;
	const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s/;
	const HEADING = /^#+\s/;
	const QUOTE = /^\s*>/;
	const FENCE = /^\s*(```|~~~)/;

	function needsGap(line, prev) {
		if (!prev.trim()) return false;
		if (HEADING.test(line)) return true;
		if (QUOTE.test(line)) return !QUOTE.test(prev);
		if (LIST_ITEM.test(line)) return !LIST_ITEM.test(prev) && !/^[ \t]/.test(prev);
		return false;
	}

	function separateBlocks(text) {
		let inCode = false;
		let prev = '';
		return text.split('\n').map((line) => {
			const gap = !inCode && needsGap(line, prev);
			if (FENCE.test(line)) inCode = !inCode;
			prev = line;
			return gap ? '\n' + line : line;
		}).join('\n');
	}

	function escapeHtml(text) {
		return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	}

	function rewriteWikilinks(text) {
		const byName = new Map(notes.map((n) => [n.name.trim().toLowerCase(), n]));
		return text.split(CODE).map((part, i) => i % 2 ? part : part.replace(WIKILINK, (all, embed, inner) => {
			const pipe = inner.indexOf('|');
			const target = (pipe < 0 ? inner : inner.slice(0, pipe)).trim().replace(/\\$/, '').trim();
			const label = pipe < 0 ? null : inner.slice(pipe + 1).trim();
			const hash = target.indexOf('#');
			const name = hash < 0 ? target : target.slice(0, hash);
			const heading = hash < 0 ? null : target.slice(hash + 1);
			const ext = (name.split('.').pop() || '').toLowerCase();

			if (embed && name.includes('.') && IMAGE_EXTS.includes(ext)) {
				// images only reach the live site after a deploy, so preview them from GitHub
				return '![' + (label || '') + '](' + RAW + 'assets/garden/' + encodeURIComponent(name) + ')';
			}
			const note = byName.get(name.trim().toLowerCase());
			const text = escapeHtml(label || name);
			if (note) {
				const anchor = heading ? '#' + slugify(heading) : '';
				return '<a class="internal-link" href="' + noteUrl(note.name) + anchor + '">' + text + '</a>';
			}
			return '<span class="internal-link unplanted" title="Not planted yet">' + text + '</span>';
		})).join('');
	}

	// kramdown's GFM task lists: "- [ ] thing" becomes a disabled checkbox
	function addTaskLists(root) {
		root.querySelectorAll('li').forEach((li) => {
			const firstOf = (node) => [...node.childNodes].find((c) => c.nodeType !== 3 || c.nodeValue.trim());
			const lead = firstOf(li);
			const holder = lead && lead.tagName === 'P' ? lead : li;
			const first = firstOf(holder);
			if (!first || first.nodeType !== 3) return;
			const m = /^\[([ xX])\]\s/.exec(first.nodeValue);
			if (!m) return;
			first.nodeValue = first.nodeValue.slice(m[0].length);
			const box = root.ownerDocument.createElement('input');
			box.type = 'checkbox';
			box.className = 'task-list-item-checkbox';
			box.disabled = true;
			box.defaultChecked = m[1] !== ' ';
			holder.insertBefore(box, first);
			li.parentElement.classList.add('task-list');
		});
		root.querySelectorAll('.task-list > li').forEach((li) => li.classList.add('task-list-item'));
	}

	// kramdown/rouge wrap code the way the site's CSS expects
	function wrapCode(root) {
		const doc = root.ownerDocument;
		root.querySelectorAll('code').forEach((code) => {
			if (code.parentElement.tagName !== 'PRE') code.className = 'language-plaintext highlighter-rouge';
		});
		root.querySelectorAll('pre').forEach((pre) => {
			const code = pre.querySelector('code');
			const lang = code && /language-(\S+)/.exec(code.className);
			if (code) code.removeAttribute('class');
			const outer = doc.createElement('div');
			outer.className = 'language-' + (lang ? lang[1] : 'plaintext') + ' highlighter-rouge';
			const inner = doc.createElement('div');
			inner.className = 'highlight';
			pre.className = 'highlight';
			pre.replaceWith(outer);
			outer.appendChild(inner);
			inner.appendChild(pre);
		});
	}

	// ---------- preview ----------

	let previewReady = false;
	let previewTimer = null;

	function renderPreview() {
		const doc = el.preview.contentDocument;
		if (!previewReady || !doc || !current) return;

		doc.querySelector('header.major h1').textContent = el.title.value.trim() || 'Untitled';

		const meta = doc.querySelector('.note-meta');
		meta.textContent = '';
		[['Added', el.added.value], ['Updated', el.updated.value]].forEach(([label, value]) => {
			if (!value) return;
			const span = doc.createElement('span');
			span.textContent = label + ' ' + formatDate(value);
			meta.append(span, ' ');
		});

		const body = doc.querySelector('.note-body');
		body.innerHTML = md.render(rewriteWikilinks(separateBlocks(el.body.value)));
		addTaskLists(body);
		wrapCode(body);
	}

	function schedulePreview() {
		clearTimeout(previewTimer);
		previewTimer = setTimeout(renderPreview, 120);
	}

	function initPreview() {
		const doc = el.preview.contentDocument;
		if (!doc || !doc.querySelector('.note-body')) return;
		if (!doc.querySelector('base')) {
			// links in the preview open the live site in a new tab
			const base = doc.createElement('base');
			base.target = '_blank';
			doc.head.appendChild(base);
		}
		previewReady = true;
		renderPreview();
	}

	el.preview.addEventListener('load', initPreview);
	initPreview(); // in case it loaded before this script ran

	// ---------- notes ----------

	function fillPicker() {
		el.picker.textContent = '';
		if (current && !current.path) el.picker.appendChild(new Option('New note (not saved yet)', ''));
		notes.forEach((n) => el.picker.appendChild(new Option(n.name, n.path)));
		el.picker.value = current ? current.path || '' : '';
	}

	async function loadNoteList() {
		let files = [];
		try {
			files = await github('/contents/_notes?ref=' + branch);
		} catch (e) {
			if (e.status !== 404) throw e;
		}
		notes = files
			.filter((f) => f.type === 'file' && f.name.endsWith('.md'))
			.map((f) => ({ name: baseName(f.path), path: f.path }))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	function showNote(note) {
		current = note;
		const fm = note.frontMatter;
		el.title.value = getField(fm, 'title');
		el.added.value = isoDate(getField(fm, 'added'));
		el.updated.value = isoDate(getField(fm, 'updated'));
		el.draft.checked = getField(fm, 'published') === 'false';
		el.body.value = note.body;
		current.savedText = composeNote();
		el.fileName.textContent = note.path || '_notes/<title>.md';
		el.deleteNote.hidden = !note.path;
		updateLiveLink();
		fillPicker();
		renderPreview();
	}

	function updateLiveLink() {
		const live = current && current.path && !el.draft.checked;
		el.viewLive.hidden = !live;
		if (live) el.viewLive.href = siteUrl + '/' + slugify(baseName(current.path));
	}

	async function openNote(path) {
		setStatus('Loading…');
		const file = await github('/contents/' + encodePath(path) + '?ref=' + branch);
		const { frontMatter, body } = splitNote(fromBase64(file.content));
		showNote({ path, sha: file.sha, frontMatter, body });
		setStatus('');
	}

	function newNote() {
		const d = today();
		showNote({ path: null, sha: null, frontMatter: ['title: ""', 'added: ' + d, 'updated: ' + d], body: '\n' });
		el.title.focus();
	}

	function confirmDiscard() {
		return !isDirty() || confirm('You have unsaved changes. Discard them?');
	}

	function fileNameFor(title) {
		return title.replace(/[\\/:*?"<>|#^[\]]/g, '').replace(/\s+/g, ' ').trim();
	}

	async function save() {
		if (busy || !current) return;
		const title = el.title.value.trim();
		if (!title) {
			setStatus('Give the note a title first.', 'error');
			el.title.focus();
			return;
		}

		let path = current.path;
		if (!path) {
			const name = fileNameFor(title);
			if (!name) return setStatus('That title has no usable characters for a file name.', 'error');
			if (notes.some((n) => n.name.toLowerCase() === name.toLowerCase())) {
				return setStatus('A note called “' + name + '” already exists.', 'error');
			}
			path = '_notes/' + name + '.md';
		}

		if (current.path && !isDirty()) return setStatus('No changes to save.');
		if (el.bump.checked) el.updated.value = today();
		const text = composeNote();

		busy = true;
		el.save.disabled = true;
		setStatus('Saving…');
		try {
			const result = await putFile(path, toBase64(text), (current.path ? 'Update ' : 'Add ') + title, current.sha);
			const isNew = !current.path;
			current.path = path;
			current.sha = result.content.sha;
			current.frontMatter = splitNote(text).frontMatter;
			current.savedText = text;
			if (isNew) {
				notes.push({ name: baseName(path), path });
				notes.sort((a, b) => a.name.localeCompare(b.name));
			}
			el.fileName.textContent = path;
			el.deleteNote.hidden = false;
			fillPicker();
			updateLiveLink();
			setStatus(el.draft.checked ? 'Saved as a draft (not on the site).' : 'Saved. Live in a minute or two.', 'ok');
			renderPreview();
		} catch (e) {
			if (e.status === 409 || e.status === 422) {
				setStatus('This note changed somewhere else (Obsidian?) since you opened it. Copy your edits, then reopen the note.', 'error');
			} else if (e.message !== 'unauthorized') {
				setStatus('Couldn’t save: ' + e.message, 'error');
			}
		} finally {
			busy = false;
			el.save.disabled = false;
		}
	}

	async function deleteCurrent() {
		if (!current || !current.path || busy) return;
		if (!confirm('Delete “' + (el.title.value || baseName(current.path)) + '”? It will be removed from the site.')) return;
		busy = true;
		setStatus('Deleting…');
		try {
			await github('/contents/' + encodePath(current.path), {
				method: 'DELETE',
				body: JSON.stringify({ message: 'Delete ' + baseName(current.path), sha: current.sha, branch })
			});
			notes = notes.filter((n) => n.path !== current.path);
			current = null;
			if (notes.length) await openNote(notes[0].path); else newNote();
			setStatus('Deleted.', 'ok');
		} catch (e) {
			if (e.message !== 'unauthorized') setStatus('Couldn’t delete: ' + e.message, 'error');
		} finally {
			busy = false;
		}
	}

	// ---------- images ----------

	function stamp() {
		const d = new Date();
		const p = (n) => String(n).padStart(2, '0');
		return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
	}

	function insertAtCursor(text) {
		const { selectionStart: start, selectionEnd: end, value } = el.body;
		el.body.value = value.slice(0, start) + text + value.slice(end);
		el.body.selectionStart = el.body.selectionEnd = start + text.length;
		schedulePreview();
	}

	async function uploadImages(files, pasted) {
		for (const file of files) {
			const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
			let name = pasted || !file.name ? 'Pasted image ' + stamp() + '.' + ext : file.name;
			setStatus('Uploading ' + name + '…');
			try {
				const content = await fileToBase64(file);
				try {
					await putFile('assets/garden/' + name, content, 'Add image ' + name);
				} catch (e) {
					if (e.status !== 422) throw e;
					// a file with that name already exists
					name = name.replace(/(\.[^.]+)?$/, ' ' + stamp() + '$1');
					await putFile('assets/garden/' + name, content, 'Add image ' + name);
				}
				insertAtCursor('![[' + name + ']]\n');
				setStatus('Image added. Save the note to keep it there.', 'ok');
			} catch (e) {
				if (e.message !== 'unauthorized') setStatus('Couldn’t upload the image: ' + e.message, 'error');
			}
		}
	}

	el.body.addEventListener('paste', (event) => {
		const files = [...(event.clipboardData ? event.clipboardData.files : [])].filter((f) => f.type.startsWith('image/'));
		if (!files.length) return;
		event.preventDefault();
		uploadImages(files, true);
	});

	el.body.addEventListener('dragover', (event) => event.preventDefault());
	el.body.addEventListener('drop', (event) => {
		const files = [...event.dataTransfer.files].filter((f) => f.type.startsWith('image/'));
		if (!files.length) return;
		event.preventDefault();
		uploadImages(files, false);
	});

	// ---------- sign in / out ----------

	async function start() {
		el.signin.hidden = true;
		el.app.hidden = false;
		setStatus('Loading notes…');
		try {
			await loadNoteList();
			if (notes.length) await openNote(notes[0].path); else newNote();
		} catch (e) {
			if (e.message !== 'unauthorized') setStatus('Couldn’t load notes: ' + e.message, 'error');
		}
	}

	function signOut(message) {
		token = null;
		storage('clear');
		current = null;
		el.app.hidden = true;
		el.signin.hidden = false;
		el.token.value = '';
		el.signinError.hidden = !message;
		el.signinError.textContent = message || '';
	}

	el.signinForm.addEventListener('submit', async (event) => {
		event.preventDefault();
		token = el.token.value.trim();
		el.signinError.hidden = true;
		try {
			await github('');
			storage('set', token);
			start();
		} catch (e) {
			if (e.message === 'unauthorized') return;
			el.signinError.hidden = false;
			el.signinError.textContent = e.status === 404
				? 'That token can’t see ' + repo + '. Check its repository access.'
				: 'Couldn’t reach GitHub: ' + e.message;
		}
	});

	// ---------- wiring ----------

	['input', 'change'].forEach((type) => {
		[el.title, el.added, el.updated, el.body].forEach((input) => input.addEventListener(type, schedulePreview));
	});
	el.draft.addEventListener('change', updateLiveLink);

	el.picker.addEventListener('change', () => {
		const path = el.picker.value;
		if (!confirmDiscard()) { fillPicker(); return; }
		if (path) openNote(path).catch((e) => setStatus('Couldn’t open the note: ' + e.message, 'error'));
	});
	el.newNote.addEventListener('click', () => { if (confirmDiscard()) newNote(); });
	el.save.addEventListener('click', save);
	el.deleteNote.addEventListener('click', deleteCurrent);
	el.signOut.addEventListener('click', () => { if (confirmDiscard()) signOut(); });

	document.addEventListener('keydown', (event) => {
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
			event.preventDefault();
			save();
		}
	});

	window.addEventListener('beforeunload', (event) => {
		if (isDirty()) event.preventDefault();
	});

	document.querySelectorAll('.tabs button').forEach((tab) => tab.addEventListener('click', () => {
		document.querySelectorAll('.tabs button').forEach((t) => t.classList.toggle('active', t === tab));
		el.panes.dataset.pane = tab.dataset.pane;
		if (tab.dataset.pane === 'preview') renderPreview();
	}));

	token = storage('get');
	if (token) start(); else signOut();
})();
