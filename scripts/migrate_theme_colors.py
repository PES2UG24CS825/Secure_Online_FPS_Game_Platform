import re

color_map = {
    r'#CFC6F2': '#1E293B',
    r'#cfc6f2': '#1E293B',
    r'#53507A': '#94A3B8',
    r'#53507a': '#94A3B8',
    r'#4C1D95': '#60A5FA',
    r'#4c1d95': '#60A5FA',
    r'#6D28D9': '#2563EB',
    r'#6d28d9': '#2563EB',
    r'#7C3AED': '#2563EB',
    r'#7c3aed': '#2563EB',
    r'#8B5CF6': '#38BDF8',
    r'#8b5cf6': '#38BDF8',
    r'#C4B5FD': '#38BDF8',
    r'#c4b5fd': '#38BDF8',
    r'#DDD6FE': '#232C3D',
    r'#ddd6fe': '#232C3D',
    r'#EDE9FE': '#161D2B',
    r'#ede9fe': '#161D2B',
    r'#F5F3FF': '#0F141E',
    r'#f5f3ff': '#0F141E',
    r'#C3BFE0': '#232C3D',
    r'#c3bfe0': '#232C3D',
    r'#DEDCEE': '#090B10',
    r'#dedcee': '#090B10',
    r'#E9E7F5': '#111622',
    r'#e9e7f5': '#111622',
    r'#D6D3EA': '#161D2B',
    r'#d6d3ea': '#161D2B',
    r'#1B1730': '#F1F5F9',
    r'#1b1730': '#F1F5F9',
    r'#2E1065': '#111622',
    r'#2e1065': '#111622',
    r'#3B0764': '#161D2B',
    r'#3b0764': '#161D2B',
    r'#1E1B4B': '#090B10',
    r'#1e1b4b': '#090B10',
}

for filepath in ['frontend/css/admin.css', 'frontend/css/player.css', 'frontend/css/ui-polish.css']:
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    original = content
    for old_c, new_c in color_map.items():
        content = re.sub(re.escape(old_c), new_c, content)

    if content != original:
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(content)
        print(f"Updated {filepath} colors to black/dark cyber theme.")

print("Color migration completed successfully.")
