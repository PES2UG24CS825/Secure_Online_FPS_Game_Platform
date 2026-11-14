import re

def retheme_file(path):
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()

    orig = content

    # Colors replacements
    # 1. Text color #090B10 -> #1E1B4B
    content = re.sub(r'color:\s*#090B10', 'color: #1E1B4B', content)
    # 2. Text color #F1F5F9 when inside light panels -> #1E1B4B
    # 3. Border #232C3D -> #DDD6FE
    content = content.replace('#232C3D', '#DDD6FE')
    # 4. Backgrounds: #0F141E, #111622, #161D2B -> #FAF5FF or #FFFFFF
    content = content.replace('#0F141E', '#FAF5FF')
    content = content.replace('#111622', '#FAF5FF')
    content = content.replace('#161D2B', '#FAF5FF')
    # 5. Remaining #090B10 -> #1E1B4B
    content = content.replace('#090B10', '#1E1B4B')

    # Specific fixes
    # modal backdrops and gradients
    content = content.replace('rgba(15, 12, 34, 0.75)', 'rgba(30, 27, 75, 0.45)')
    content = content.replace('rgba(15, 12, 34, 0.96)', 'rgba(255, 255, 255, 0.96)')
    content = content.replace('rgba(15, 12, 34, 0.98)', 'rgba(255, 255, 255, 0.98)')
    content = content.replace('linear-gradient(135deg, rgba(30, 27, 75, 0.95), rgba(15, 12, 34, 0.98))', 'linear-gradient(135deg, #7C3AED, #6D28D9)')
    content = content.replace('linear-gradient(112deg,#111622,#161D2B)', 'linear-gradient(135deg, #7C3AED, #6D28D9)')

    if content != orig:
        with open(path, 'w', encoding='utf-8') as f:
            f.write(content)
        print(f"Updated {path}")
    else:
        print(f"No changes in {path}")

for p in ['frontend/css/player.css', 'frontend/css/admin.css', 'frontend/css/ui-polish.css']:
    retheme_file(p)
