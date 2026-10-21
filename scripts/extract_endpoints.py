import re,sys,collections
call=re.compile(r'(?<![\w$])([A-Za-z_$][\w$]*)\.(get|post|put|patch|del|delete|getNotAuth|postNotAuth)\(')
lit=re.compile(r'`(?:[^`\\]|\\.)*`|"[^"]*"|\'[^\']*\'')
def url_expr(s,i):
    # i at char after '('
    j=i
    while s[j] in ' \n': j+=1
    if s.startswith('{',j):
        k=s.find('url:',j,j+400)
        if k<0: return None
        j=k+4
    # scan expression until top-level ',' or ')' or '}'
    depth=0;k=j
    while k<len(s):
        c=s[k]
        if c in '`"\'':
            m=lit.match(s,k); k=m.end(); continue
        if c in '([{': depth+=1
        elif c in ')]}':
            if depth==0: break
            depth-=1
        elif c==',' and depth==0: break
        k+=1
    return s[j:k]
def norm(e):
    e=re.sub(r'\([^()]*\?"admin/":""\)\+?','[admin/]',e)
    e=re.sub(r'\$\{[^}]*"admin/"[^}]*\}','[admin/]',e)
    e=re.sub(r'\$\{[^}]*"partners"[^}]*\}','[partners]',e)
    parts=[];pos=0
    for m in lit.finditer(e):
        between=e[pos:m.start()]
        if re.search(r'[\w.]',between.replace('+','').replace('(','').replace(')','').replace('[admin/]','').replace('[partners]','')): parts.append('{}')
        if '[admin/]' in between: parts.append('[admin/]')
        parts.append(re.sub(r'\$\{[^}]*\}','{}',m.group(0)[1:-1])); pos=m.end()
    tail=e[pos:]
    if '[admin/]' in tail: parts.insert(0,'[admin/]')
    if re.search(r'\w',tail.replace('[admin/]','').replace('[partners]','')): parts.append('{}')
    return ''.join(parts) or '<'+e[:60]+'>'
res=collections.defaultdict(set)
for fn in sys.argv[1:]:
    s=open(fn,encoding='utf-8').read()
    for m in call.finditer(s):
        e=url_expr(s,m.end())
        if e is None: continue
        u=norm(e)
        if not re.search(r'[a-z]{3,}', u) or re.search(r'[ <>=]', u) or u.startswith(('http','#')): continue
        if not re.fullmatch(r'[a-z0-9_/{}.\[\]-]+', u): continue
        res[u].add({'del':'DELETE','getNotAuth':'GET(noauth)','postNotAuth':'POST(noauth)'}.get(m.group(2),m.group(2).upper()))
for u in sorted(res,key=lambda x:x.replace('[admin/]','').lstrip('/').replace('v2/','')): print(','.join(sorted(res[u])).ljust(18), u)
