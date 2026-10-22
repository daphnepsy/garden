source "https://rubygems.org"

# Plain Jekyll (not the github-pages gem) so the garden plugin in _plugins/
# runs. The site is built and deployed by .github/workflows/pages.yml.
gem "jekyll", "~> 3.10"
gem "commonmarker", "~> 0.23" # CommonMark + GitHub extensions, like Obsidian (see _plugins/markdown.rb)
gem "webrick"

group :jekyll_plugins do
  gem "jekyll-seo-tag", "2.8.0" # 2.9 breaks project og:image paths
end
