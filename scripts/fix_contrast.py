import re

def fix_css(path):
    with open(path, 'r', encoding='utf-8') as f:
        text = f.read()

    orig = text
    # Replace white text on light backgrounds
    text = re.sub(r'color:\s*#F1F5F9\s*!important', 'color:#1E1B4B !important', text, flags=re.IGNORECASE)
    text = re.sub(r'color:\s*#F1F5F9', 'color:#1E1B4B', text, flags=re.IGNORECASE)
    text = re.sub(r'color:\s*#cbd5e1\s*!important', 'color:#475569 !important', text, flags=re.IGNORECASE)
    text = re.sub(r'color:\s*#cbd5e1', 'color:#475569', text, flags=re.IGNORECASE)
    text = re.sub(r'color:\s*#e2e8f0\s*!important', 'color:#334155 !important', text, flags=re.IGNORECASE)
    text = re.sub(r'color:\s*#e2e8f0', 'color:#334155', text, flags=re.IGNORECASE)

    if text != orig:
        with open(path, 'w', encoding='utf-8') as f:
            f.write(text)
        print(f"Updated {path}")
    else:
        print(f"No changes in {path}")

for p in ['frontend/css/player.css', 'frontend/css/ui-polish.css', 'frontend/css/admin.css']:
    fix_css(p)
