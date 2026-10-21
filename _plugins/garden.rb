# Makes Obsidian-flavoured notes in _notes/ work on the site:
#
#   [[Note]]  [[Note|label]]  [[Note#Heading]]   -> links to /<note>
#   ![[photo.png]]                               -> image from assets/garden/
#   [[Note that doesn't exist]]                  -> plain text, styled as "unplanted"
#
# It also gives every note a `backlinks` list (the notes that link to it).
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

  def self.parse(inner)
    # inside an Obsidian table the pipe is escaped: [[Note\|label]]
    target, label = inner.split("|", 2).map(&:strip)
    target = target.chomp("\\").strip
    name, heading = target.split("#", 2)
    [name.to_s, heading, label]
  end

  Jekyll::Hooks.register :site, :post_read do |site|
    notes = notes_by_name(site)
    notes.each_value { |doc| doc.data["backlinks"] = [] }

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
