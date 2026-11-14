import glob

guard = '<script>if (window.location.port !== "5000" && window.location.port !== "") { window.location.replace(`http://${window.location.hostname}:5000${window.location.pathname.replace(/^\\/frontend/, "")}${window.location.search}`); }</script>'

for f in glob.glob('frontend/*.html'):
    with open(f, 'r', encoding='utf-8') as fl:
        content = fl.read()
    if 'window.location.port === "5500"' in content:
        content = content.replace(
            '<script>if (window.location.port === "5500") { window.location.replace(`http://${window.location.hostname}:5000${window.location.pathname.replace(/^\\/frontend/, \'\')}${window.location.search}`); }</script>',
            guard
        )
        with open(f, 'w', encoding='utf-8') as fl:
            fl.write(content)
        print('Updated:', f)
    elif '<head>' in content and 'window.location.port' not in content:
        content = content.replace('<head>', f'<head>\n  {guard}')
        with open(f, 'w', encoding='utf-8') as fl:
            fl.write(content)
        print('Injected:', f)

print('Done updating HTML files.')
