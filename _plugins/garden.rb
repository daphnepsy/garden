# Makes Obsidian-flavoured notes in _notes/ work on the site:
#
#   [[Note]]  [[Note|label]]  [[Note#Heading]]   -> links to the note
#   [[Folder/Note]]                              -> same, when names clash
#   ![[photo.png]]                               -> image from assets/garden/
#   [[Note that doesn't exist]]                  -> plain text, styled as "unplanted"
#
# Notes can live in folders: _notes/Some Folder/My Note.md is served at
# /some-folder/my-note, and gets `folder: "Some Folder"` for the garden index.
#
# `added` and `updated` dates are read as dates even when quoted, so the
# garden can sort by them. It also gives every note a `backlinks` list (the
# notes that link to it). The Markdown itself is rendered by _plugins/markdown.rb.
# Links are matched on file name (or folder/name), case-insensitively, like Obsidian does.

module Garden
  WIKILINK = /(!?)\[\[([^\[\]]+?)\]\]/
  # fenced code blocks and inline code are left alone
  CODE = /(^```.*?^```|^~~~.*?^~~~|`[^`\n]+`)/m
  IMAGE_EXTS = %w[png jpg jpeg gif webp svg avif].freeze

  def self.key(name)
    name.strip.downcase
  end

  # "Some Folder/My Note" for _notes/Some Folder/My Note.md
  def self.note_path(doc)
    doc.relative_path.sub(%r!\A_notes/!, "").sub(%r!\.md\z!, "")
  end

  # Both "my note" and "some folder/my note" find the note
  def self.notes_by_name(site)
    site.collections["notes"].docs.each_with_object({}) do |doc, by_name|
      by_name[key(doc.basename_without_ext)] ||= doc
      by_name[key(note_path(doc))] = doc
    end
  end

  # Calls the block with each wikilink outside code, replacing it with the result
  def self.rewrite(markdown)
    markdown.split(CODE).each_with_index.map do |part, i|
      i.odd? ? part : part.gsub(WIKILINK) { yield Regexp.last_match(1) == "!", Regexp.last_match(2) }
    end.join
  end

  def self.parse(inner)
    # inside an Obsidian table the pipe is escaped: [[Note\|label]]
    target, label = inner.split("|", 2).map(&:strip)
    target = target.chomp("\\").strip
    name, heading = target.split("#", 2)
    [name.to_s, heading, label]
  end

  def self.to_date(value)
    return value if value.nil? || value.is_a?(Date) || value.is_a?(Time)
    Date.parse(value.to_s)
  rescue ArgumentError
    nil
  end

  # Every folder (the garden itself first) with its subfolders and notes, for
  # the Finder-style homepage. Folders are listed by name and notes by title,
  # like Finder; `id` is the slug the homepage uses in its #links.
  def self.folder_tree(docs)
    folders = Hash.new do |all, path|
      parent = path.empty? ? nil : path.rpartition("/").first
      all[parent]["folders"] << path unless parent.nil?
      all[path] = {
        "path" => path,
        "name" => path.empty? ? "Garden" : path.split("/").last,
        "id" => path.empty? ? "" : Jekyll::Utils.slugify(path),
        "parent" => parent,
        "folders" => [],
        "notes" => [],
      }
    end
    folders[""]
    docs.each { |doc| folders[doc.data["folder"]]["notes"] << doc }

    folders.each_value do |folder|
      folder["folders"] = folder["folders"].sort_by(&:downcase).map { |path| folders[path] }
      folder["notes"] = folder["notes"].sort_by { |doc| doc.data["title"].to_s.downcase }
      folder["parent"] = folders[folder["parent"]] if folder["parent"]
      folder["trail"] = []
      ancestor = folder
      while ancestor
        folder["trail"].unshift(ancestor)
        ancestor = ancestor["parent"].is_a?(Hash) ? ancestor["parent"] : nil
      end
    end
    latest_update(folders[""])
    folders.values.sort_by { |folder| folder["path"].downcase }
  end

  # A folder was last updated when the newest note anywhere inside it was
  def self.latest_update(folder)
    dates = folder["notes"].map { |doc| doc.data["updated"] } + folder["folders"].map { |sub| latest_update(sub) }
    folder["updated"] = dates.compact.max
  end

  Jekyll::Hooks.register :site, :post_read do |site|
    notes = notes_by_name(site)
    docs = site.collections["notes"].docs
    docs.each do |doc|
      parts = note_path(doc).split("/")
      doc.data["folder"] = parts[0..-2].join("/")
      doc.data["permalink"] = "/" + parts.map { |part| Jekyll::Utils.slugify(part) }.join("/")
      doc.data["backlinks"] = []
      %w[added updated].each { |field| doc.data[field] = to_date(doc.data[field]) }
    end

    site.data["garden_folders"] = folder_tree(docs)

    docs.each do |doc|
      linked = []
      rewrite(doc.content) do |_embed, inner|
        linked << notes[key(parse(inner)[0])]
        ""
      end
      linked.compact.uniq.each do |target|
        target.data["backlinks"] << doc unless target == doc
      end
    end
  end

  Jekyll::Hooks.register :notes, :pre_render do |doc|
    site = doc.site
    notes = notes_by_name(site)
    baseurl = site.config["baseurl"].to_s

    doc.content = rewrite(doc.content) do |embed, inner|
      name, heading, label = parse(inner)
      ext = File.extname(name).delete(".").downcase

      if embed && IMAGE_EXTS.include?(ext)
        %(![#{label}](#{baseurl}/assets/garden/#{name.gsub(" ", "%20")}))
      elsif (note = notes[key(name)])
        anchor = heading ? "##{Jekyll::Utils.slugify(heading)}" : ""
        %(<a class="internal-link" href="#{baseurl}#{note.url}#{anchor}">#{label || name}</a>)
      else
        %(<span class="internal-link unplanted" title="Not planted yet">#{label || name}</span>)
      end
    end
  end
end
