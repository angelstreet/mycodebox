#!/usr/bin/env python3
"""Which product files the exported UI reviewer imports, outside its fixed export list (ui-review-lane.js).

    python3 scripts/ui-review-closure.py <clone> <ref> <out file>

Follows every import of scripts/review/*.py at <ref>, transitively, lazy ones inside functions included. A fixed list
broke the gate the day the reviewer imported a file outside it (2026-11-26). Nothing is executed: the files are only parsed.
"""
import ast
import posixpath
import subprocess
import sys

START = 'scripts/review'
# what the reviewer and the product's scripts put on sys.path, beside the importing file's own folder; '' is the repo root
ROOTS = (START, 'scripts', '')


def closure(files, read):
    """files: every path of the tree; read(path) -> source. -> the sorted paths the imports need."""
    beside = {}
    for f in files:
        beside.setdefault(posixpath.dirname(f), []).append(f)
    todo = [f for f in beside.get(START, []) if f.endswith('.py')]
    seen = set(todo)

    def add(path):
        if path in files and path not in seen:
            seen.add(path)
            todo.append(path)

    def module(root, parts):
        for i in range(1, len(parts) + 1):  # every package on the way runs its __init__
            stem = posixpath.join(root, *parts[:i])
            for path in (f'{stem}.py', f'{stem}/__init__.py'):
                if path in files:
                    add(path)
                    # a module may read a data file that lies beside it
                    for other in beside[posixpath.dirname(path)]:
                        if not other.endswith('.py') and posixpath.dirname(path) not in ('', 'scripts'):
                            add(other)

    while todo:
        path = todo.pop()
        if not path.endswith('.py'):
            continue
        try:
            tree = ast.parse(read(path))
        except (SyntaxError, ValueError):
            continue  # the reviewer's own run says so if it needs this file
        here = posixpath.dirname(path)
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for root in (here, *ROOTS):
                    for a in node.names:
                        module(root, a.name.split('.'))
            elif isinstance(node, ast.ImportFrom):
                base = node.module.split('.') if node.module else []
                roots = (here, *ROOTS)
                if node.level:
                    up = here.split('/')
                    roots = ('/'.join(up[:len(up) - node.level + 1]),)
                for root in roots:
                    # `from a import b`: b may be a submodule
                    for a in node.names:
                        module(root, base + ([] if a.name == '*' else [a.name]))
                    if base:
                        module(root, base)
    return sorted(seen)


def main():
    clone, ref, out = sys.argv[1:4]

    def git(*a):
        return subprocess.run(['git', '-C', clone, *a], capture_output=True, check=True).stdout

    files = set(git('ls-tree', '-r', '-z', '--name-only', ref).decode().split('\0')) - {''}
    found = closure(files, lambda p: git('cat-file', 'blob', f'{ref}:{p}'))
    with open(out, 'w', encoding='utf-8') as fh:
        fh.write(''.join(f'{p}\0' for p in found))


if __name__ == '__main__':
    main()
