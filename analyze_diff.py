import sys, re, subprocess

diff = subprocess.check_output(
    ['git', 'diff', 'HEAD', '--', 'data/nuzlocke-scenarios/'],
    cwd='/home/austin/nuzlocke-workspace/pokemon-showdown'
).decode()

EVO_WORDS = ['stone', 'scale', 'electirizer', 'magmarizer', 'upgrade', 'dubious',
             'protector', 'reaper', 'sachet', 'whipped', 'prism']

def is_expected_item(val):
    v = val.lower()
    if v.endswith('berry'): return True
    if any(w in v for w in EVO_WORDS): return True
    return False

current_file = None
in_items = False
in_tms = False
item_removed = {}
item_added = {}
tm_removed = {}
tm_added = {}

for line in diff.splitlines():
    m = re.match(r'^diff --git .*/([^/]+)\.json', line)
    if m:
        current_file = m.group(1)
        in_items = in_tms = False
        continue

    # Detect section transitions
    stripped = line.lstrip('+-').strip()
    if stripped.startswith('"items"'):
        in_items = True; in_tms = False; continue
    if stripped.startswith('"tmMoves"'):
        in_tms = True; in_items = False; continue
    # End of array
    if (in_items or in_tms) and stripped in ('],', ']', '},', '}'):
        in_items = in_tms = False; continue

    if not (in_items or in_tms): continue
    if not (line.startswith('-') or line.startswith('+')):  continue

    val_m = re.search(r'"([^"]+)"', line)
    if not val_m: continue
    val = val_m.group(1)

    if in_items and is_expected_item(val): continue

    if in_items:
        if line.startswith('-'):
            item_removed.setdefault(current_file, []).append(val)
        else:
            item_added.setdefault(current_file, []).append(val)
    elif in_tms:
        if line.startswith('-'):
            tm_removed.setdefault(current_file, []).append(val)
        else:
            tm_added.setdefault(current_file, []).append(val)

all_files = sorted(set(list(item_removed) + list(item_added) + list(tm_removed) + list(tm_added)))
for f in all_files:
    ir = item_removed.get(f, [])
    ia = item_added.get(f, [])
    tr = tm_removed.get(f, [])
    ta = tm_added.get(f, [])
    if ir or ia or tr or ta:
        print(f'\n{f}:')
        if ir: print(f'  items removed: {ir}')
        if ia: print(f'  items added:   {ia}')
        if tr: print(f'  TMs removed:   {tr}')
        if ta: print(f'  TMs added:     {ta}')
