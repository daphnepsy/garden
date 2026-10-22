# Renders Markdown with commonmarker, GitHub's CommonMark library, instead of
# kramdown. CommonMark plus GitHub's extensions (tables, task lists,
# strikethrough, bare links) is the flavour Obsidian writes, and the one the
# editor's preview (markdown-it) follows, so all three agree. Like Obsidian, a
# single line break is a line break and raw HTML is allowed.
require "commonmarker"

module Jekyll
  module Converters
    class Markdown
      class Garden
        OPTIONS = [:UNSAFE, :HARDBREAKS, :TABLE_PREFER_STYLE_ATTRIBUTES].freeze
        EXTENSIONS = [:table, :tasklist, :strikethrough, :autolink].freeze

        def initialize(config)
          @config = config
        end

        def convert(content)
          html = CommonMarker.render_html(content, OPTIONS, EXTENSIONS)
          # headings get ids, so [[Note#Heading]] links land on them
          html.gsub(%r!<h([1-6])>(.*?)</h\1>!m) do
            level, text = Regexp.last_match(1), Regexp.last_match(2)
            %(<h#{level} id="#{Jekyll::Utils.slugify(text.gsub(%r!<[^>]+>!, ""))}">#{text}</h#{level}>)
          end
        end
      end
    end
  end
end
