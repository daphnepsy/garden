// Garden editor (/editor/): edit and organize notes in _notes/ through the
// GitHub API, and preview them inside the real note layout (/editor/preview/).
//
// The preview renders Markdown with markdown-it, which follows CommonMark like
// the site's renderer (commonmarker, _plugins/markdown.rb) and Obsidian, and
// handles [[links]] the way _plugins/garden.rb does. Keep them in step.

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
		app: $('app'), tree: $('tree'), newNote: $('new-note'), newFolder: $('new-folder'), status: $('status'),
		viewLive: $('view-live'), deleteNote: $('delete-note'), signOut: $('sign-out'), save: $('save'),
		title: $('title'), folder: $('folder'), added: $('added'), updated: $('updated'), bump: $('bump'), draft: $('draft'),
		body: $('body'), fileName: $('file-name'), preview: $('preview'), panes: document.querySelector('.panes')
	};

	let token = null;
	let notes = [];               // [{ path, name, folder, sha }] for every note in _notes/
	let newFolders = new Set();   // folders made here that have no notes yet
	let selectedFolder = '';      // where "New note" puts a note
	let current = null;           // { path, folder, sha, frontMatter, savedText }
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

	// "_notes/Some Folder/My Note.md" -> "Some Folder/My Note"
	function notePath(path) {
		return path.replace(/^_notes\//, '').replace(/\.md$/, '');
	}

	// the URL the site gives a note (see _plugins/garden.rb): /some-folder/my-note
	function noteUrl(path) {
		return '/' + notePath(path).split('/').map(slugify).join('/');
	}

	function baseName(path) {
		return path.split('/').pop().replace(/\.md$/, '');
	}

	function folderOf(path) {
		return notePath(path).split('/').slice(0, -1).join('/');
	}

	function pathFor(folder, name) {
		return '_notes/' + (folder ? folder + '/' : '') + name + '.md';
	}

	function cleanName(name) {
		return name.replace(/[\\/:*?"<>|#^[\]]/g, '').replace(/\s+/g, ' ').trim();
	}

	function cleanFolder(folder) {
		return folder.split('/').map(cleanName).filter(Boolean).join('/');
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
		if (res.status === 403 && /not accessible/i.test((data && data.message) || '')) {
			// the token can read the (public) repo but isn't allowed to change it
			const error = new Error('your token can’t change ' + repo + '. On GitHub, edit the token: set Repository access to “Only select repositories” → ' + repo + ', and Repository permissions → Contents to “Read and write”. Then save again.');
			error.status = 403;
			throw error;
		}
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

	function conflict(message) {
		const error = new Error(message);
		error.conflict = true;
		return error;
	}

	// The latest commit on the branch and every file in it
	async function head() {
		const ref = await github('/git/ref/heads/' + branch);
		const commit = await github('/git/commits/' + ref.object.sha);
		const tree = await github('/git/trees/' + commit.tree.sha + '?recursive=1');
		return { commit: ref.object.sha, tree: commit.tree.sha, files: tree.tree.filter((f) => f.type === 'blob') };
	}

	function notesFrom(files) {
		return files
			.filter((f) => f.path.startsWith('_notes/') && f.path.endsWith('.md'))
			.map((f) => ({ path: f.path, name: baseName(f.path), folder: folderOf(f.path), sha: f.sha }))
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	// Makes one commit out of several file changes, so a move (add + delete) is a
	// single step. Each change is { path, content } to write text, { path, sha }
	// to reuse an existing file's contents, or { path, sha: null } to delete.
	// `check(files)` runs against the latest files first and can throw to stop.
	async function commitChanges(changes, message, check) {
		for (let attempt = 0; ; attempt++) {
			const latest = await head();
			if (check) check(latest.files);
			const tree = await github('/git/trees', {
				method: 'POST',
				body: JSON.stringify({
					base_tree: latest.tree,
					tree: changes.map((c) => Object.assign({ path: c.path, mode: '100644', type: 'blob' },
						'content' in c ? { content: c.content } : { sha: c.sha }))
				})
			});
			const commit = await github('/git/commits', {
				method: 'POST',
				body: JSON.stringify({ message, tree: tree.sha, parents: [latest.commit] })
			});
			try {
				await github('/git/refs/heads/' + branch, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha }) });
			} catch (e) {
				// something else was pushed meanwhile: start again from the new latest commit
				if (e.status === 422 && attempt === 0) continue;
				throw e;
			}
			const files = (await github('/git/trees/' + tree.sha + '?recursive=1')).tree.filter((f) => f.type === 'blob');
			notes = notesFrom(files);
			return files;
		}
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
		return current && (composeNote() !== current.savedText || (current.path && el.folder.value !== current.folder));
	}

	// ---------- Markdown, matching the site ----------

	// same options as _plugins/markdown.rb: raw HTML, line breaks kept, bare links linked
	const md = window.markdownit({ html: true, breaks: true, linkify: true });
	// ~~strike~~ as <del>, like commonmarker
	md.renderer.rules.s_open = () => '<del>';
	md.renderer.rules.s_close = () => '</del>';

	const WIKILINK = /(!?)\[\[([^[\]]+?)\]\]/g;
	const CODE = /(^```[\s\S]*?^```|^~~~[\s\S]*?^~~~|`[^`\n]+`)/m;

	function escapeHtml(text) {
		return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	}

	function rewriteWikilinks(text) {
		// like the site, a link can name just the note or its folder too
		const byName = new Map();
		notes.forEach((n) => {
			if (!byName.has(n.name.trim().toLowerCase())) byName.set(n.name.trim().toLowerCase(), n);
		});
		notes.forEach((n) => byName.set(notePath(n.path).toLowerCase(), n));
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
				return '<a class="internal-link" href="' + baseurl + noteUrl(note.path) + anchor + '">' + text + '</a>';
			}
			return '<span class="internal-link unplanted" title="Not planted yet">' + text + '</span>';
		})).join('');
	}

	// GitHub-style task lists, as commonmarker renders them: "- [ ] thing"
	// becomes a disabled checkbox
	function addTaskLists(root) {
		root.querySelectorAll('li').forEach((li) => {
			const firstOf = (node) => [...node.childNodes].find((c) => c.nodeType !== 3 || c.nodeValue.trim());
			const lead = firstOf(li);
			const holder = lead && lead.tagName === 'P' ? lead : li;
			const first = firstOf(holder);
			if (!first || first.nodeType !== 3) return;
			const m = /^\[([ xX])\]\s/.exec(first.nodeValue);
			if (!m) return;
			first.nodeValue = ' ' + first.nodeValue.slice(m[0].length);
			const box = root.ownerDocument.createElement('input');
			box.type = 'checkbox';
			box.disabled = true;
			box.defaultChecked = m[1] !== ' ';
			holder.insertBefore(box, first);
		});
	}

	// ---------- preview ----------

	let previewReady = false;
	let previewTimer = null;

	function renderPreview() {
		const doc = el.preview.contentDocument;
		if (!previewReady || !doc || !current) return;

		doc.querySelector('header.major h1').textContent = el.title.value.trim() || 'Untitled';

		// "← Garden / Folder", as on the site
		const back = doc.querySelector('.note-back');
		const garden = back.querySelector('a');
		back.textContent = '';
		back.appendChild(garden);
		if (el.folder.value) {
			const link = doc.createElement('a');
			link.href = baseurl + '/#' + slugify(el.folder.value);
			link.textContent = el.folder.value.replace(/\//g, ' / ');
			back.append(' / ', link);
		}

		const meta = doc.querySelector('.note-meta');
		meta.textContent = '';
		[['Added', el.added.value], ['Updated', el.updated.value]].forEach(([label, value]) => {
			if (!value) return;
			const span = doc.createElement('span');
			span.textContent = label + ' ' + formatDate(value);
			meta.append(span, ' ');
		});

		const body = doc.querySelector('.note-body');
		body.innerHTML = md.render(rewriteWikilinks(el.body.value));
		addTaskLists(body);
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

	// ---------- notes and folders ----------

	function allFolders() {
		const folders = new Set(newFolders);
		notes.forEach((n) => {
			// "A/B" also means there's an "A"
			const parts = n.folder ? n.folder.split('/') : [];
			parts.forEach((_, i) => folders.add(parts.slice(0, i + 1).join('/')));
		});
		return [...folders].sort((a, b) => a.localeCompare(b));
	}

	function fillFolderPicker() {
		const folders = allFolders();
		const value = el.folder.value || (current && current.folder) || '';
		el.folder.textContent = '';
		el.folder.appendChild(new Option('Top level', ''));
		folders.forEach((f) => el.folder.appendChild(new Option(f.replace(/\//g, ' / '), f)));
		el.folder.appendChild(new Option('New folder…', '\u0000new'));
		el.folder.value = folders.includes(value) ? value : '';
	}

	// The sidebar: each folder is a drop target, each note can be dragged
	function renderTree() {
		el.tree.textContent = '';
		['', ...allFolders()].forEach((folder) => {
			const group = document.createElement('div');
			group.className = 'folder' + (folder === selectedFolder ? ' selected' : '');
			group.dataset.folder = folder;

			const head = document.createElement('button');
			head.type = 'button';
			head.className = 'folder-name';
			const depth = folder ? folder.split('/').length : 0;
			head.style.paddingLeft = (0.5 + depth * 0.9) + 'rem';
			head.textContent = folder ? folder.split('/').pop() : 'Garden';
			head.title = folder ? 'Folder “' + folder + '”' : 'Top level of the garden';
			head.addEventListener('click', () => { selectedFolder = folder; renderTree(); });
			group.appendChild(head);

			const list = document.createElement('ul');
			notes.filter((n) => n.folder === folder).forEach((n) => {
				const item = document.createElement('li');
				const link = document.createElement('button');
				link.type = 'button';
				link.className = 'note' + (current && current.path === n.path ? ' current' : '');
				link.style.paddingLeft = (1.4 + depth * 0.9) + 'rem';
				link.textContent = n.name;
				link.draggable = true;
				link.addEventListener('dragstart', (event) => {
					event.dataTransfer.setData('text/x-garden-note', n.path);
					event.dataTransfer.effectAllowed = 'move';
				});
				link.addEventListener('click', () => {
					if (!current || current.path !== n.path) {
						if (confirmDiscard()) openNote(n.path).catch(showError('open the note'));
					}
					showPane('edit');
				});
				item.appendChild(link);
				list.appendChild(item);
			});
			if (!list.children.length && folder) {
				const empty = document.createElement('li');
				empty.className = 'empty';
				empty.textContent = 'Drag a note here';
				list.appendChild(empty);
			}
			group.appendChild(list);

			group.addEventListener('dragover', (event) => {
				if (!event.dataTransfer.types.includes('text/x-garden-note')) return;
				event.preventDefault();
				event.stopPropagation();
				group.classList.add('drop');
			});
			group.addEventListener('dragleave', (event) => {
				if (!group.contains(event.relatedTarget)) group.classList.remove('drop');
			});
			group.addEventListener('drop', (event) => {
				event.preventDefault();
				group.classList.remove('drop');
				const path = event.dataTransfer.getData('text/x-garden-note');
				if (path) moveNote(path, folder);
			});
			el.tree.appendChild(group);
		});
	}

	function refreshLists() {
		fillFolderPicker();
		renderTree();
	}

	async function loadNotes() {
		notes = notesFrom((await head()).files);
	}

	function showNote(note) {
		current = note;
		const fm = note.frontMatter;
		el.title.value = getField(fm, 'title');
		el.added.value = isoDate(getField(fm, 'added'));
		el.updated.value = isoDate(getField(fm, 'updated'));
		el.draft.checked = getField(fm, 'published') === 'false';
		el.body.value = note.body;
		el.folder.value = '';
		refreshLists();
		el.folder.value = note.folder;
		current.savedText = composeNote();
		showSaved();
		renderPreview();
	}

	// file name, delete button and live link for the note as last saved
	function showSaved() {
		el.fileName.textContent = current.path || pathFor(el.folder.value, '<title>');
		el.deleteNote.hidden = !current.path;
		updateLiveLink();
	}

	function updateLiveLink() {
		const live = current && current.path && !el.draft.checked;
		el.viewLive.hidden = !live;
		if (live) el.viewLive.href = siteUrl + noteUrl(current.path);
	}

	async function openNote(path) {
		setStatus('Loading…');
		const note = notes.find((n) => n.path === path);
		const blob = await github('/git/blobs/' + note.sha);
		const { frontMatter, body } = splitNote(fromBase64(blob.content));
		showNote({ path, folder: note.folder, sha: note.sha, frontMatter, body });
		setStatus('');
	}

	function newNote() {
		const d = today();
		showNote({ path: null, folder: selectedFolder, sha: null, frontMatter: ['title: ""', 'added: ' + d, 'updated: ' + d], body: '\n' });
		showPane('edit');
		el.title.focus();
	}

	function askForFolder() {
		const name = prompt('Name the new folder (use / to put it inside another folder, like “Food/Baking”):');
		const folder = name ? cleanFolder(name) : '';
		if (!folder) return null;
		newFolders.add(folder);
		return folder;
	}

	function confirmDiscard() {
		return !isDirty() || confirm('You have unsaved changes. Discard them?');
	}

	function showError(action) {
		return (e) => {
			if (e.message === 'unauthorized') return;
			setStatus(e.conflict ? e.message : 'Couldn’t ' + action + ': ' + e.message, 'error');
		};
	}

	// stops a commit if the note changed elsewhere (e.g. pushed from Obsidian) since it was opened
	function unchangedSince(path, sha) {
		return (files) => {
			const file = files.find((f) => f.path === path);
			if (!file || file.sha !== sha) {
				throw conflict('“' + baseName(path) + '” changed somewhere else (Obsidian?) since you opened it. Copy your edits, then reopen the note.');
			}
		};
	}

	function notTaken(path, except) {
		return (files) => {
			if (path !== except && files.some((f) => f.path.toLowerCase() === path.toLowerCase())) {
				throw conflict('There’s already a note called “' + baseName(path) + '” in ' + (folderOf(path) || 'the top level') + '.');
			}
		};
	}

	async function save() {
		if (busy || !current) return;
		const title = el.title.value.trim();
		if (!title) {
			setStatus('Give the note a title first.', 'error');
			el.title.focus();
			return;
		}
		const name = current.path ? baseName(current.path) : cleanName(title);
		if (!name) return setStatus('That title has no usable characters for a file name.', 'error');
		if (current.path && !isDirty()) return setStatus('No changes to save.');

		const folder = el.folder.value;
		const path = pathFor(folder, name);
		const moved = current.path && path !== current.path;
		if (el.bump.checked) el.updated.value = today();
		const text = composeNote();
		const changes = [{ path, content: text }];
		if (moved) changes.push({ path: current.path, sha: null });
		const message = !current.path ? 'Add ' + title : moved ? 'Update ' + title + ' and move it to ' + (folder || 'the top level') : 'Update ' + title;

		busy = true;
		el.save.disabled = true;
		setStatus('Saving…');
		try {
			await commitChanges(changes, message, (files) => {
				if (current.path) unchangedSince(current.path, current.sha)(files);
				notTaken(path, current.path)(files);
			});
			newFolders.delete(folder);
			current.path = path;
			current.folder = folder;
			current.sha = notes.find((n) => n.path === path).sha;
			current.frontMatter = splitNote(text).frontMatter;
			current.savedText = text;
			refreshLists();
			showSaved();
			setStatus(el.draft.checked ? 'Saved as a draft (not on the site).' : 'Saved. Live in a minute or two.', 'ok');
			renderPreview();
		} catch (e) {
			showError('save')(e);
		} finally {
			busy = false;
			el.save.disabled = false;
		}
	}

	async function moveNote(path, folder) {
		const note = notes.find((n) => n.path === path);
		if (!note || note.folder === folder || busy) return;

		// with unsaved edits, the move goes in with the next save
		if (current && current.path === path && isDirty()) {
			el.folder.value = folder;
			showSaved();
			renderPreview();
			setStatus('Moved to ' + (folder || 'the top level') + ' when you save.', 'ok');
			return;
		}

		const to = pathFor(folder, note.name);
		busy = true;
		setStatus('Moving…');
		try {
			await commitChanges([{ path: to, sha: note.sha }, { path, sha: null }],
				'Move ' + note.name + ' to ' + (folder || 'the top level'),
				(files) => { unchangedSince(path, note.sha)(files); notTaken(to, path)(files); });
			newFolders.delete(folder);
			if (current && current.path === path) {
				current.path = to;
				current.folder = folder;
				el.folder.value = folder;
				current.savedText = composeNote();
				showSaved();
				renderPreview();
			}
			refreshLists();
			setStatus('Moved “' + note.name + '” to ' + (folder || 'the top level') + '. Its link is now ' + noteUrl(to), 'ok');
		} catch (e) {
			showError('move the note')(e);
		} finally {
			busy = false;
		}
	}

	async function deleteCurrent() {
		if (!current || !current.path || busy) return;
		if (!confirm('Delete “' + (el.title.value || baseName(current.path)) + '”? It will be removed from the site.')) return;
		const path = current.path;
		busy = true;
		setStatus('Deleting…');
		try {
			await commitChanges([{ path, sha: null }], 'Delete ' + baseName(path), unchangedSince(path, current.sha));
			current = null;
			if (notes.length) await openNote(notes[0].path); else newNote();
			setStatus('Deleted.', 'ok');
		} catch (e) {
			showError('delete')(e);
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
			await loadNotes();
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

	el.folder.addEventListener('change', () => {
		if (el.folder.value === '\u0000new') {
			const folder = askForFolder();
			el.folder.value = current ? current.folder : '';
			if (folder) {
				refreshLists();
				el.folder.value = folder;
			}
		}
		if (current && !current.path) selectedFolder = el.folder.value;
		showSaved();
		renderTree();
		schedulePreview();
	});
	el.newNote.addEventListener('click', () => { if (confirmDiscard()) newNote(); });
	el.newFolder.addEventListener('click', () => {
		const folder = askForFolder();
		if (!folder) return;
		selectedFolder = folder;
		refreshLists();
		setStatus('Folder “' + folder + '” made. Drag notes into it or make a new note there. (Folders are saved once they hold a note.)', 'ok');
	});
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

	// small screens show one pane at a time
	function showPane(pane) {
		document.querySelectorAll('.tabs button').forEach((t) => t.classList.toggle('active', t.dataset.pane === pane));
		el.panes.dataset.pane = pane;
		if (pane === 'preview') renderPreview();
	}

	document.querySelectorAll('.tabs button').forEach((tab) => tab.addEventListener('click', () => showPane(tab.dataset.pane)));

	token = storage('get');
	if (token) start(); else signOut();
})();
