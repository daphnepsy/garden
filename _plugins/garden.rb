# Makes Obsidian-flavoured notes in _notes/ work on the site:
#
#   [[Note]]  [[Note|label]]  [[Note#Heading]]   -> links to /<note>
#   ![[photo.png]]                               -> image from assets/garden/
#   [[Note that doesn't exist]]                  -> plain text, styled as "unplanted"
#
# `added` and `updated` dates are read as dates even when quoted, so the
# garden can sort by them. It also gives every note a `backlinks` list (the notes that link to it), and
# lets a list, heading or quote start right under a line of text, as Obsidian
# does (the site's Markdown otherwise needs a blank line before them).
# Links are matched on file name, case-insensitively, like Obsidian does.

module Garden
  WIKILINK = /(!?)\[\[([^\[\]]+?)\]\]/
  # fenced code blocks and inline code are left alone
  CODE = /(^```.*?^```|^~~~.*?^~~~|`[^`\n]+`)/m
  IMAGE_EXTS = %w[png jpg jpeg gif webp svg avif].freeze

  def self.key(name)
    name.strip.downcase
  end

  def self.notes_by_name(site)
    site.collections["notes"].docs.to_h { |doc| [key(doc.basename_without_ext), doc] }
  end

  # Calls the block with each wikilink outside code, replacing it with the result
  def self.rewrite(markdown)
    markdown.split(CODE).each_with_index.map do |part, i|
      i.odd? ? part : part.gsub(WIKILINK) { yield Regexp.last_match(1) == "!", Regexp.last_match(2) }
    end.join
  end

  LIST_ITEM = /\A\s*([-*+]|\d+[.)])\s/
  HEADING = /\A#+\s/
  QUOTE = /\A\s*>/
  FENCE = /\A\s*(```|~~~)/

  def self.needs_gap?(line, prev)
    return false if prev.strip.empty?
    return true if line.match?(HEADING)
    return !prev.match?(QUOTE) if line.match?(QUOTE)
    return !prev.match?(LIST_ITEM) && !prev.start_with?(" ", "\t") if line.match?(LIST_ITEM)
    false
  end

  # Adds a blank line between a line of text and a block that starts under it
  def self.separate_blocks(markdown)
    in_code = false
    prev = ""
    markdown.lines.map do |line|
      gap = !in_code && needs_gap?(line, prev)
      in_code = !in_code if line.match?(FENCE)
      prev = line
      gap ? "\n#{line}" : line
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

  Jekyll::Hooks.register :site, :post_read do |site|
    notes = notes_by_name(site)
    notes.each_value do |doc|
      doc.data["backlinks"] = []
      %w[added updated].each { |field| doc.data[field] = to_date(doc.data[field]) }
    end

    notes.each_value do |doc|
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

    doc.content = rewrite(separate_blocks(doc.content)) do |embed, inner|
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
