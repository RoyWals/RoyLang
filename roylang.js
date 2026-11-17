// RoyLang v6.2 Compiler, AST Codegen & 2D/WebGL2 Engine Runtime (lazy-loaded module)
function _royEscapeHtml(str) {
  if (typeof window !== "undefined" && typeof window.escapeHtml === "function") return window.escapeHtml(str);
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function _royArrayBufferToBase64(ab) {
  if (typeof window !== "undefined" && typeof window.arrayBufferToBase64 === "function") return window.arrayBufferToBase64(ab);
  const bytes = new Uint8Array(ab);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

async function _royEnsureJSZip() {
  if (typeof window !== "undefined" && typeof window.ensureJSZipReady === "function") return window.ensureJSZipReady();
  if (typeof window !== "undefined" && window.JSZip) return window.JSZip;
  const mod = await import("jszip");
  return mod.default || mod;
}

export const RoyLang = (function() {
  const KEYWORDS = new Set([
    'game', 'entity', 'class', 'extends', 'super', 'delete', 'enum', 'spawn', 'new', 'this', 'self',
    'var', 'let', 'const', 'fn', 'return', 'if', 'elif', 'else', 'match',
    'while', 'for', 'in', 'repeat', 'break', 'continue',
    'on', 'after', 'every', 'import', 'export',
    'true', 'false', 'null', 'and', 'or', 'not', 'await'
  ]);

  const ASYNC_ROOTS = new Set(['save', 'load', 'submitScore', 'topScores', 'wait', 'loadJson', 'pathfindAsync']);
  const ASYNC_MEMBERS = new Set([
    'world.get', 'world.set', 'world.update', 'world.push',
    'rooms.list', 'rooms.create', 'rooms.join', 'rooms.leave', 'rooms.getState', 'rooms.setState', 'rooms.sendEvent',
    'player.get',
    'RoySDK.player.get',
    'RoySDK.storage.get', 'RoySDK.storage.set', 'RoySDK.storage.remove', 'RoySDK.storage.getAll',
    'RoySDK.leaderboard.submit', 'RoySDK.leaderboard.getTop',
    'RoySDK.world.get', 'RoySDK.world.set', 'RoySDK.world.update', 'RoySDK.world.push',
    'RoySDK.rooms.list', 'RoySDK.rooms.create', 'RoySDK.rooms.join', 'RoySDK.rooms.leave',
    'RoySDK.rooms.getState', 'RoySDK.rooms.setState', 'RoySDK.rooms.sendEvent'
  ]);

  function guessMime(fileName) {
    const ext = String(fileName || '').split('.').pop().toLowerCase();
    const map = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
      webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
      mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac',
      json: 'application/json', txt: 'text/plain', roy: 'text/plain', roylang: 'text/plain',
      md: 'text/plain', csv: 'text/csv', html: 'text/html', css: 'text/css', js: 'application/javascript'
    };
    return map[ext] || 'application/octet-stream';
  }

  function compileError(msg, line, col, fileName) {
    const prefix = fileName ? `${fileName} ` : '';
    const err = new Error(`[RoyLang ${prefix}Строка ${line}:${col}] ${msg}`);
    err.royLine = line;
    err.royCol = col;
    err.royFile = fileName || 'main.roy';
    return err;
  }

  function tokenize(src, startLine = 1, startCol = 1, fileName = '') {
    src = String(src || '').replace(/^\uFEFF/, '');
    const tokens = [];
    let i = 0;
    let line = startLine;
    let col = startCol;
    const len = src.length;

    const peek = (off = 0) => (i + off < len ? src[i + off] : '');
    const advance = () => {
      const ch = src[i++];
      if (ch === '\n') { line++; col = 1; } else { col++; }
      return ch;
    };

    while (i < len) {
      const ch = peek();
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
        advance();
        continue;
      }
      if (ch === '/' && peek(1) === '/') {
        while (i < len && peek() !== '\n') advance();
        continue;
      }
      if (ch === '/' && peek(1) === '*') {
        const sLine = line, sCol = col;
        advance(); advance();
        let closed = false;
        while (i < len) {
          if (peek() === '*' && peek(1) === '/') {
            advance(); advance();
            closed = true;
            break;
          }
          advance();
        }
        if (!closed) throw compileError('Незакрытый многострочный комментарий /* ... */', sLine, sCol, fileName);
        continue;
      }
      if (ch === '#') {
        if (!/[0-9a-fA-F]{3,8}/.test(src.slice(i + 1, i + 9))) {
          while (i < len && peek() !== '\n') advance();
          continue;
        }
      }

      const tLine = line, tCol = col;

      if (ch === '"' || ch === "'") {
        const quote = advance();
        let out = '';
        let closed = false;
        let parts = null;
        while (i < len) {
          const c = advance();
          if (c === quote) { closed = true; break; }
          if (c === '\\') {
            if (i >= len) break;
            const esc = advance();
            if (esc === 'n') out += '\n';
            else if (esc === 't') out += '\t';
            else if (esc === 'r') out += '\r';
            else out += esc;
          } else if (quote === '"' && c === '$' && peek() === '{') {
            advance();
            if (!parts) parts = [];
            if (out.length > 0) {
              parts.push({ kind: 'lit', value: out });
              out = '';
            }
            const eLine = line, eCol = col;
            let depth = 1;
            let exprCode = '';
            while (i < len && depth > 0) {
              const ic = advance();
              if (ic === '{') {
                depth++;
                exprCode += ic;
              } else if (ic === '}') {
                depth--;
                if (depth > 0) exprCode += ic;
              } else if (ic === '"' || ic === "'") {
                const iq = ic;
                exprCode += ic;
                while (i < len) {
                  const sc = advance();
                  exprCode += sc;
                  if (sc === '\\' && i < len) {
                    exprCode += advance();
                  } else if (sc === iq) {
                    break;
                  }
                }
              } else {
                exprCode += ic;
              }
            }
            if (depth > 0) throw compileError('Незакрытая интерполяция ${...} в строке', eLine, eCol, fileName);
            if (!exprCode.trim()) throw compileError('Пустое выражение внутри ${}', eLine, eCol, fileName);
            parts.push({ kind: 'expr', code: exprCode, line: eLine, col: eCol });
          } else {
            out += c;
          }
        }
        if (!closed) throw compileError('Незакрытая строка', tLine, tCol, fileName);
        if (parts) {
          if (out.length > 0) parts.push({ kind: 'lit', value: out });
          tokens.push({ type: 'TSTRING', parts, line: tLine, col: tCol });
        } else {
          tokens.push({ type: 'STRING', value: out, line: tLine, col: tCol });
        }
        continue;
      }

      if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(peek(1)))) {
        let numStr = '';
        let hasDot = false;
        while (i < len) {
          const c = peek();
          if (/[0-9]/.test(c)) {
            numStr += advance();
          } else if (c === '.' && !hasDot && peek(1) !== '.' && /[0-9]/.test(peek(1))) {
            hasDot = true;
            numStr += advance();
          } else {
            break;
          }
        }
        if (!hasDot && peek() === 'x' && /[0-9]/.test(peek(1))) {
          advance();
          let hStr = '';
          while (i < len && /[0-9]/.test(peek())) hStr += advance();
          tokens.push({ type: 'SIZE', width: Number(numStr), height: Number(hStr), line: tLine, col: tCol });
          continue;
        }
        if (peek() === 'm' && peek(1) === 's' && !/[a-zA-Z0-9_]/.test(peek(2))) {
          advance(); advance();
          tokens.push({ type: 'DURATION', ms: Number(numStr), line: tLine, col: tCol });
          continue;
        }
        if (peek() === 's' && !/[a-zA-Z0-9_]/.test(peek(1))) {
          advance();
          tokens.push({ type: 'DURATION', ms: Number(numStr) * 1000, line: tLine, col: tCol });
          continue;
        }
        tokens.push({ type: 'NUMBER', value: Number(numStr), line: tLine, col: tCol });
        continue;
      }

      if (/[a-zA-Z_]/.test(ch)) {
        let ident = '';
        while (i < len && /[a-zA-Z0-9_]/.test(peek())) ident += advance();
        if (KEYWORDS.has(ident)) {
          tokens.push({ type: 'KW', value: ident, line: tLine, col: tCol });
        } else {
          tokens.push({ type: 'IDENT', value: ident, line: tLine, col: tCol });
        }
        continue;
      }

      const two = src.slice(i, i + 2);
      const three = src.slice(i, i + 3);
      if (three === '..=' || three === '...') {
        advance(); advance(); advance();
        tokens.push({ type: 'OP', value: three, line: tLine, col: tCol });
        continue;
      }
      if (['|>', '..', '=>', '??', '?.', '**', '==', '!=', '<=', '>=', '&&', '||', '+=', '-=', '*=', '/=', '%=', '++', '--'].includes(two)) {
        advance(); advance();
        tokens.push({ type: 'OP', value: two, line: tLine, col: tCol });
        continue;
      }

      if ('+-*/%<>=!?'.includes(ch)) {
        tokens.push({ type: 'OP', value: advance(), line: tLine, col: tCol });
        continue;
      }
      if ('(){}[],.:;'.includes(ch)) {
        tokens.push({ type: 'PUNC', value: advance(), line: tLine, col: tCol });
        continue;
      }

      throw compileError(`Неизвестный символ "${ch}"`, tLine, tCol, fileName);
    }

    tokens.push({ type: 'EOF', value: '', line: line, col: col });
    return tokens;
  }

  function parse(source, fileName = '') {
    const tokens = tokenize(source, 1, 1, fileName);

    function parseTokenStream(toks, entryMode = 'program') {
      let pos = 0;

      const peek = (off = 0) => toks[Math.min(pos + off, toks.length - 1)];
      const prev = () => toks[Math.max(0, pos - 1)];
      const atEnd = () => peek().type === 'EOF';
      const isVal = (type, val) => peek().type === type && (val === undefined || peek().value === val);
      const match = (type, val) => {
        if (isVal(type, val)) { pos++; return prev(); }
        return null;
      };
      const expect = (type, val, msg) => {
        const t = peek();
        if (t.type === type && (val === undefined || t.value === val)) { pos++; return t; }
        throw compileError(msg || `Ожидалось "${val || type}", встречено "${t.value || t.type}"`, t.line, t.col, fileName);
      };

      const canContinueSameLineExpr = () => {
        if (pos === 0) return false;
        return peek().line === prev().line;
      };

      function parseProgram() {
        const body = [];
        let gameHeader = null;
        const assetBlocks = [];
        while (!atEnd()) {
          while (match('PUNC', ';')) {}
          if (atEnd()) break;
          if (isVal('KW', 'game') && (peek(1).type === 'STRING' || (peek(1).type === 'PUNC' && peek(1).value === '{'))) {
            if (gameHeader) throw compileError('Блок game может быть указан только один раз', peek().line, peek().col, fileName);
            gameHeader = parseGameHeader();
          } else if (isVal('IDENT', 'assets') && peek(1).type === 'PUNC' && peek(1).value === '{') {
            assetBlocks.push(parseAssetsHeader());
          } else {
            body.push(parseStatement());
          }
        }
        return { type: 'Program', gameHeader, assetBlocks, body, fileName };
      }

      function parseGameHeader() {
        const kw = expect('KW', 'game');
        let title = null;
        if (peek().type === 'STRING') title = expect('STRING').value;
        expect('PUNC', '{', 'Ожидалась "{" после объявления game');
        const props = {};
        while (!isVal('PUNC', '}') && !atEnd()) {
          if (match('PUNC', ',') || match('PUNC', ';')) continue;
          const kTok = peek();
          let kName = '';
          if (kTok.type === 'IDENT' || kTok.type === 'STRING' || kTok.type === 'KW') {
            kName = kTok.value;
            pos++;
          } else {
            throw compileError('Ожидалось имя свойства в блоке game', kTok.line, kTok.col, fileName);
          }
          expect('PUNC', ':', 'Ожидалось ":" после свойства ' + kName);
          const valNode = parseExpression();
          props[kName] = valNode;
          match('PUNC', ',');
          match('PUNC', ';');
        }
        expect('PUNC', '}', 'Ожидалась "}" в конце блока game');
        return { type: 'GameHeader', title, props, line: kw.line, col: kw.col };
      }

      function parseAssetsHeader() {
        const kw = expect('IDENT', 'assets');
        expect('PUNC', '{', 'Ожидалась "{" после assets');
        const entries = [];
        while (!isVal('PUNC', '}') && !atEnd()) {
          if (match('PUNC', ',') || match('PUNC', ';')) continue;
          const kTok = peek();
          if (kTok.type !== 'IDENT' && kTok.type !== 'STRING' && kTok.type !== 'KW') {
            throw compileError('Ожидалось имя ресурса в блоке assets', kTok.line, kTok.col, fileName);
          }
          const alias = kTok.value;
          pos++;
          if (!match('PUNC', ':')) expect('OP', '=', 'Ожидалось ":" или "=" после имени ресурса ' + alias);
          const pathTok = expect('STRING', undefined, 'Путь к ассету должен быть строкой, например "assets/hero.png"');
          entries.push({ alias, path: pathTok.value, line: kTok.line, col: kTok.col });
          match('PUNC', ',');
          match('PUNC', ';');
        }
        expect('PUNC', '}', 'Ожидалась "}" в конце блока assets');
        return { type: 'AssetsDecl', entries, line: kw.line, col: kw.col };
      }

      function parseImportDecl() {
        const kw = expect('KW', 'import');
        if (peek().type === 'STRING') {
          const pTok = expect('STRING');
          match('PUNC', ';');
          return { type: 'ImportDecl', mode: 'sideEffect', path: pTok.value, specifiers: [], nsAlias: null, line: kw.line, col: kw.col };
        }
        if (isVal('OP', '*')) {
          pos++;
          const asTok = peek();
          if (asTok.type !== 'IDENT' || asTok.value !== 'as') throw compileError('Ожидалось "as" после import *', asTok.line, asTok.col, fileName);
          pos++;
          const nsTok = expect('IDENT', undefined, 'Ожидалось имя пространства имён');
          const fromTok = peek();
          if (fromTok.type !== 'IDENT' || fromTok.value !== 'from') throw compileError('Ожидалось "from"', fromTok.line, fromTok.col, fileName);
          pos++;
          const pTok = expect('STRING', undefined, 'Ожидался путь к модулю в кавычках');
          match('PUNC', ';');
          return { type: 'ImportDecl', mode: 'namespace', path: pTok.value, specifiers: [], nsAlias: nsTok.value, line: kw.line, col: kw.col };
        }
        if (match('PUNC', '{')) {
          const specifiers = [];
          while (!isVal('PUNC', '}') && !atEnd()) {
            const impName = expect('IDENT', undefined, 'Ожидалось имя импорта');
            let alias = impName.value;
            if (peek().type === 'IDENT' && peek().value === 'as') {
              pos++;
              alias = expect('IDENT', undefined, 'Ожидался псевдоним после as').value;
            }
            specifiers.push({ name: impName.value, alias });
            if (!match('PUNC', ',')) break;
          }
          expect('PUNC', '}', 'Ожидалась "}" в списке импорта');
          const fromTok = peek();
          if (fromTok.type !== 'IDENT' || fromTok.value !== 'from') throw compileError('Ожидалось "from" после {...}', fromTok.line, fromTok.col, fileName);
          pos++;
          const pTok = expect('STRING', undefined, 'Ожидался путь к модулю в кавычках');
          match('PUNC', ';');
          return { type: 'ImportDecl', mode: 'named', path: pTok.value, specifiers, nsAlias: null, line: kw.line, col: kw.col };
        }
        throw compileError('Ожидалась строка пути, { ... } или * as ... после import', peek().line, peek().col, fileName);
      }

      function parseExportStmt() {
        const kw = expect('KW', 'export');
        const nt = peek();
        if (nt.type === 'OP' && nt.value === '*') {
          pos++;
          const fromTok = peek();
          if (fromTok.type !== 'IDENT' || fromTok.value !== 'from') {
            throw compileError('Ожидалось "from" после export *', fromTok.line, fromTok.col, fileName);
          }
          pos++;
          const pTok = expect('STRING', undefined, 'Ожидался путь к модулю в кавычках после from');
          match('PUNC', ';');
          return { type: 'ReExportDecl', mode: 'all', path: pTok.value, specifiers: [], line: kw.line, col: kw.col };
        }
        if (nt.type === 'PUNC' && nt.value === '{') {
          pos++;
          const specifiers = [];
          while (!isVal('PUNC', '}') && !atEnd()) {
            const expName = expect('IDENT', undefined, 'Ожидалось имя экспорта');
            let alias = expName.value;
            if (peek().type === 'IDENT' && peek().value === 'as') {
              pos++;
              alias = expect('IDENT', undefined, 'Ожидался псевдоним после as').value;
            }
            specifiers.push({ name: expName.value, alias });
            if (!match('PUNC', ',')) break;
          }
          expect('PUNC', '}', 'Ожидалась "}" в списке экспорта');
          if (peek().type === 'IDENT' && peek().value === 'from') {
            pos++;
            const pTok = expect('STRING', undefined, 'Ожидался путь к модулю в кавычках');
            match('PUNC', ';');
            return { type: 'ReExportDecl', mode: 'named', path: pTok.value, specifiers, line: kw.line, col: kw.col };
          }
          match('PUNC', ';');
          return { type: 'LocalExportList', specifiers, line: kw.line, col: kw.col };
        }
        let inner = null;
        if ((nt.type === 'KW' && nt.value === 'fn') || (nt.type === 'IDENT' && nt.value === 'function')) inner = parseFnDecl();
        else if (nt.type === 'IDENT' && nt.value === 'task' && peek(1).type === 'IDENT' && peek(2).type === 'PUNC' && peek(2).value === '(') inner = parseTaskDecl();
        else if (nt.type === 'KW' && (nt.value === 'entity' || nt.value === 'class')) inner = parseEntityDecl();
        else if (nt.type === 'KW' && nt.value === 'enum') inner = parseEnumDecl();
        else if (nt.type === 'KW' && (nt.value === 'var' || nt.value === 'let' || nt.value === 'const')) inner = parseVarDecl();
        else throw compileError('После export поддерживаются fn, task, entity, class, enum, let/var/const или { ... } from', nt.line, nt.col, fileName);
        inner.exported = true;
        return inner;
      }

      function parseParamDefs(requireParens = true) {
        const params = [];
        if (requireParens) {
          expect('PUNC', '(', 'Ожидалась "(" для списка параметров');
        } else if (!match('PUNC', '(')) {
          return params;
        }
        if (!isVal('PUNC', ')')) {
          do {
            const isRest = !!match('OP', '...');
            if (!isRest && match('PUNC', '{')) {
              const props = [];
              while (!isVal('PUNC', '}') && !atEnd()) {
                const kTok = expect('IDENT', undefined, 'Ожидалось имя свойства в параметре { ... }');
                let alias = kTok.value;
                if (match('PUNC', ':')) alias = expect('IDENT', undefined, 'Ожидалось имя после ":"').value;
                let defVal = null;
                if (match('OP', '=')) defVal = parseExpression();
                props.push({ key: kTok.value, alias, defVal });
                if (!match('PUNC', ',')) break;
              }
              expect('PUNC', '}', 'Ожидалась "}" в параметре');
              let objDef = null;
              if (match('OP', '=')) objDef = parseExpression();
              params.push({ pattern: { type: 'ObjectPat', props }, defVal: objDef, rest: false });
            } else if (!isRest && match('PUNC', '[')) {
              const elements = [];
              while (!isVal('PUNC', ']') && !atEnd()) {
                const eRest = !!match('OP', '...');
                const nTok = expect('IDENT', undefined, 'Ожидалось имя в параметре [ ... ]');
                let defVal = null;
                if (!eRest && match('OP', '=')) defVal = parseExpression();
                elements.push({ name: nTok.value, rest: eRest, defVal });
                if (!match('PUNC', ',') || eRest) break;
              }
              expect('PUNC', ']', 'Ожидалась "]" в параметре');
              let arrDef = null;
              if (match('OP', '=')) arrDef = parseExpression();
              params.push({ pattern: { type: 'ArrayPat', elements }, defVal: arrDef, rest: false });
            } else {
              const pTok = expect('IDENT', undefined, 'Ожидалось имя параметра');
              let defVal = null;
              if (!isRest && match('OP', '=')) {
                defVal = parseExpression();
              }
              params.push({ name: pTok.value, defVal, rest: isRest });
              if (isRest) break;
            }
          } while (match('PUNC', ','));
        }
        expect('PUNC', ')', 'Ожидалась ")" после списка параметров');
        return params;
      }

      function parseBlock() {
        const open = expect('PUNC', '{', 'Ожидалась "{" для начала блока');
        const stmts = [];
        while (!isVal('PUNC', '}') && !atEnd()) {
          while (match('PUNC', ';')) {}
          if (isVal('PUNC', '}')) break;
          stmts.push(parseStatement());
        }
        expect('PUNC', '}', 'Ожидалась "}" в конце блока');
        return { type: 'Block', stmts, line: open.line, col: open.col };
      }

      function parseStatement() {
        while (match('PUNC', ';')) {}
        const t = peek();

        if (t.type === 'KW') {
          if (t.value === 'import') return parseImportDecl();
          if (t.value === 'export') return parseExportStmt();
          if (t.value === 'var' || t.value === 'let' || t.value === 'const') return parseVarDecl();
          if (t.value === 'fn') return parseFnDecl();
          if (t.value === 'entity' || t.value === 'class') return parseEntityDecl();
          if (t.value === 'enum') return parseEnumDecl();
          if (t.value === 'on') return parseOnHook();
          if (t.value === 'after') return parseAfterHook();
          if (t.value === 'every') return parseEveryHook();
          if (t.value === 'if') return parseIf();
          if (t.value === 'match') return parseMatch(false);
          if (t.value === 'while') return parseWhile();
          if (t.value === 'for') return parseFor();
          if (t.value === 'repeat') return parseRepeat();
          if (t.value === 'return') return parseReturn();
          if (t.value === 'delete') {
            pos++;
            const target = parsePostfix();
            if (target.type !== 'Member' && target.type !== 'Index') {
              throw compileError('Ожидалось поле объекта (delete obj.key или delete obj[k])', t.line, t.col, fileName);
            }
            match('PUNC', ';');
            return { type: 'DeleteStmt', target, line: t.line, col: t.col };
          }
          if (t.value === 'break') { pos++; match('PUNC', ';'); return { type: 'Break', line: t.line, col: t.col }; }
          if (t.value === 'continue') { pos++; match('PUNC', ';'); return { type: 'Continue', line: t.line, col: t.col }; }
        }

        if (t.type === 'IDENT' && t.value === 'function' && peek(1).type === 'IDENT') {
          return parseFnDecl();
        }
        if (t.type === 'IDENT' && t.value === 'task' && peek(1).type === 'IDENT' && peek(2).type === 'PUNC' && peek(2).value === '(') {
          return parseTaskDecl();
        }
        if (isVal('PUNC', '{')) return parseBlock();

        const expr = parseExpression();
        match('PUNC', ';');
        return { type: 'ExprStmt', expr, line: t.line, col: t.col };
      }

      function parseVarDecl() {
        const kw = expect('KW');
        if (match('PUNC', '[')) {
          const elements = [];
          while (!isVal('PUNC', ']') && !atEnd()) {
            const rest = !!match('OP', '...');
            const nTok = expect('IDENT', undefined, 'Ожидалось имя переменной в [деструктуризации]');
            let defVal = null;
            if (!rest && match('OP', '=')) defVal = parseExpression();
            elements.push({ name: nTok.value, rest, defVal });
            if (!match('PUNC', ',') || rest) break;
          }
          expect('PUNC', ']', 'Ожидалась "]" в деструктуризации массива');
          expect('OP', '=', 'Ожидалось "=" в деструктуризации');
          const init = parseExpression();
          match('PUNC', ';');
          return { type: 'VarDecl', kind: kw.value, pattern: { type: 'ArrayPat', elements }, init, line: kw.line, col: kw.col };
        }
        if (match('PUNC', '{')) {
          const props = [];
          while (!isVal('PUNC', '}') && !atEnd()) {
            const kTok = expect('IDENT', undefined, 'Ожидалось имя свойства в {деструктуризации}');
            let alias = kTok.value;
            if (match('PUNC', ':')) {
              alias = expect('IDENT', undefined, 'Ожидалось локальное имя после ":"').value;
            }
            let defVal = null;
            if (match('OP', '=')) defVal = parseExpression();
            props.push({ key: kTok.value, alias, defVal });
            if (!match('PUNC', ',')) break;
          }
          expect('PUNC', '}', 'Ожидалась "}" в деструктуризации объекта');
          expect('OP', '=', 'Ожидалось "=" в деструктуризации');
          const init = parseExpression();
          match('PUNC', ';');
          return { type: 'VarDecl', kind: kw.value, pattern: { type: 'ObjectPat', props }, init, line: kw.line, col: kw.col };
        }
        const nameTok = expect('IDENT', undefined, 'Ожидалось имя переменной');
        let init = null;
        if (match('OP', '=')) {
          init = parseExpression();
        }
        match('PUNC', ';');
        return { type: 'VarDecl', kind: kw.value, name: nameTok.value, init, line: kw.line, col: kw.col };
      }

      function parseFnDecl() {
        let kw = null;
        if (isVal('KW', 'fn')) kw = expect('KW', 'fn');
        else if (isVal('IDENT', 'function')) { pos++; kw = prev(); }
        else kw = expect('KW', 'fn');
        const nameTok = expect('IDENT', undefined, 'Ожидалось имя функции');
        const params = parseParamDefs(true);
        let body = null;
        if (match('OP', '=>')) {
          const expr = parseExpression();
          match('PUNC', ';');
          body = { type: 'Block', stmts: [{ type: 'Return', value: expr, line: expr.line, col: expr.col }], line: expr.line, col: expr.col };
        } else {
          body = parseBlock();
        }
        return { type: 'FnDecl', name: nameTok.value, params, body, usedJsFunction: kw.value === 'function', line: kw.line, col: kw.col };
      }

      function parseTaskDecl() {
        const kw = expect('IDENT', 'task');
        const nameTok = expect('IDENT', undefined, 'Ожидалось имя корутины task');
        const params = parseParamDefs(true);
        const body = parseBlock();
        return { type: 'TaskDecl', name: nameTok.value, params, body, line: kw.line, col: kw.col };
      }

      function parseEntityDecl() {
        const kw = expect('KW');
        const isClass = kw.value === 'class';
        const nameTok = expect('IDENT', undefined, `Ожидалось имя ${isClass ? 'класса (class)' : 'сущности (entity)'}`);
        const ctorParams = isVal('PUNC', '(') ? parseParamDefs(true) : [];
        let superName = null;
        if (match('KW', 'extends')) {
          superName = expect('IDENT', undefined, 'Ожидалось имя родительского класса после extends').value;
        }
        expect('PUNC', '{', `Ожидалась "{" после объявления ${isClass ? 'class' : 'entity'}`);
        const fields = [];
        const methods = [];
        const states = [];
        const entityTimers = [];
        let initMethod = null;
        while (!isVal('PUNC', '}') && !atEnd()) {
          while (match('PUNC', ';') || match('PUNC', ',')) {}
          if (isVal('PUNC', '}')) break;
          const nt = peek();
          if (isVal('KW', 'fn') || (isVal('IDENT', 'function') && peek(1).type === 'IDENT')) {
            const m = parseFnDecl();
            if (m.name === 'init') initMethod = m;
            else methods.push(m);
          } else if (nt.type === 'IDENT' && nt.value === 'task' && peek(1).type === 'IDENT' && peek(2).type === 'PUNC' && peek(2).value === '(') {
            const tDecl = parseTaskDecl();
            tDecl.isTask = true;
            methods.push(tDecl);
          } else if (nt.type === 'IDENT' && nt.value === 'state' && peek(1).type === 'STRING') {
            pos++;
            const stName = expect('STRING').value;
            expect('PUNC', '{', `Ожидалась "{" после state "${stName}"`);
            const handlers = {};
            while (!isVal('PUNC', '}') && !atEnd()) {
              while (match('PUNC', ';') || match('PUNC', ',')) {}
              if (isVal('PUNC', '}')) break;
              if (match('KW', 'on')) {
                const hTok = expect('IDENT', undefined, 'Ожидалось enter, update, draw или exit в state');
                const hParams = parseParamDefs(false);
                const hBody = parseBlock();
                handlers[hTok.value] = { params: hParams, body: hBody, line: hTok.line };
              } else if (isVal('KW', 'fn') || (isVal('IDENT', 'function') && peek(1).type === 'IDENT')) {
                const hm = parseFnDecl();
                handlers[hm.name] = { params: hm.params, body: hm.body, line: hm.line };
              } else {
                const ut = peek();
                throw compileError(`Внутри state "${stName}" ожидались "on enter/update/draw/exit" или "fn ...", встречено "${ut.value || ut.type}"`, ut.line, ut.col, fileName);
              }
            }
            expect('PUNC', '}', `Ожидалась "}" в конце state "${stName}"`);
            states.push({ name: stName, handlers, line: nt.line, col: nt.col });
          } else if (isVal('KW', 'after')) {
            entityTimers.push(parseAfterHook());
          } else if (isVal('KW', 'every')) {
            entityTimers.push(parseEveryHook());
          } else if (isVal('KW', 'let') || isVal('KW', 'var') || isVal('KW', 'const')) {
            const vd = parseVarDecl();
            if (!vd.name) throw compileError(`Внутри ${isClass ? 'class' : 'entity'} поля должны иметь простые имена`, vd.line, vd.col, fileName);
            fields.push({ name: vd.name, init: vd.init, line: vd.line, col: vd.col });
          } else if (nt.type === 'IDENT' && (peek(1).value === '=' || peek(1).value === ':')) {
            const fTok = nt; pos++;
            pos++;
            const fVal = parseExpression();
            match('PUNC', ';'); match('PUNC', ',');
            fields.push({ name: fTok.value, init: fVal, line: fTok.line, col: fTok.col });
          } else {
            throw compileError(`Внутри ${isClass ? 'class' : 'entity'} ожидались поля, методы fn/task, state "..." или after/every, встречено "${nt.value || nt.type}"`, nt.line, nt.col, fileName);
          }
        }
        expect('PUNC', '}', `Ожидалась "}" в конце ${isClass ? 'class' : 'entity'}`);
        return { type: isClass ? 'ClassDecl' : 'EntityDecl', name: nameTok.value, ctorParams, superName, fields, methods, states, entityTimers, initMethod, line: kw.line, col: kw.col };
      }

      function parseEnumDecl() {
        const kw = expect('KW', 'enum');
        const nameTok = expect('IDENT', undefined, 'Ожидалось имя enum');
        expect('PUNC', '{', 'Ожидалась "{" после enum');
        const entries = [];
        while (!isVal('PUNC', '}') && !atEnd()) {
          if (match('PUNC', ',') || match('PUNC', ';')) continue;
          const mTok = expect('IDENT', undefined, 'Ожидалось имя элемента enum');
          let valNode = null;
          if (match('OP', '=') || match('PUNC', ':')) {
            valNode = parseExpression();
          }
          entries.push({ name: mTok.value, val: valNode });
          match('PUNC', ',');
          match('PUNC', ';');
        }
        expect('PUNC', '}', 'Ожидалась "}" в конце enum');
        return { type: 'EnumDecl', name: nameTok.value, entries, line: kw.line, col: kw.col };
      }

      function parseOnHook() {
        const kw = expect('KW', 'on');
        const evTok = expect('IDENT', undefined, 'Ожидалось имя события (start, update, draw, click, keydown, enter, exit)');
        let sceneFilter = null;
        if (peek().type === 'STRING') {
          sceneFilter = expect('STRING').value;
        }
        const params = parseParamDefs(false);
        const body = parseBlock();
        return { type: 'OnHook', event: evTok.value, sceneFilter, params, body, line: kw.line, col: kw.col };
      }

      function parseAfterHook() {
        const kw = expect('KW', 'after');
        let msNode = null;
        if (peek().type === 'DURATION') {
          const d = peek(); pos++;
          msNode = { type: 'Literal', value: d.ms, line: d.line, col: d.col };
        } else {
          msNode = parseExpression();
        }
        const body = parseBlock();
        return { type: 'AfterHook', msExpr: msNode, body, line: kw.line, col: kw.col };
      }

      function parseEveryHook() {
        const kw = expect('KW', 'every');
        let msNode = null;
        if (peek().type === 'DURATION') {
          const d = peek(); pos++;
          msNode = { type: 'Literal', value: d.ms, line: d.line, col: d.col };
        } else {
          msNode = parseExpression();
        }
        const body = parseBlock();
        return { type: 'EveryHook', msExpr: msNode, body, line: kw.line, col: kw.col };
      }

      function parseIf() {
        const kw = expect('KW', isVal('KW', 'elif') ? 'elif' : 'if');
        const cond = parseExpression();
        const thenBlock = parseBlock();
        let elseBranch = null;
        if (isVal('KW', 'elif')) {
          elseBranch = parseIf();
        } else if (match('KW', 'else')) {
          elseBranch = isVal('KW', 'if') ? parseIf() : parseBlock();
        }
        return { type: 'If', cond, thenBlock, elseBranch, line: kw.line, col: kw.col };
      }

      function parseMatch(asExpr) {
        const kw = expect('KW', 'match');
        const subject = parseExpression();
        expect('PUNC', '{', 'Ожидалась "{" после выражения match');
        const arms = [];
        while (!isVal('PUNC', '}') && !atEnd()) {
          if (match('PUNC', ',') || match('PUNC', ';')) continue;
          const patterns = [];
          let isDefault = false;
          do {
            if (isVal('IDENT', '_')) {
              pos++;
              isDefault = true;
              patterns.push({ kind: 'wildcard' });
            } else {
              const first = parseOr();
              if (isVal('OP', '..') || isVal('OP', '..=')) {
                const inclusive = peek().value === '..=';
                pos++;
                const second = parseOr();
                patterns.push({ kind: 'range', start: first, end: second, inclusive });
              } else {
                patterns.push({ kind: 'value', expr: first });
              }
            }
          } while (match('PUNC', ','));

          if (!match('OP', '=>')) {
            expect('PUNC', ':', 'Ожидалось "=>" или ":" в ветке match');
          }

          let body = null;
          if (isVal('PUNC', '{')) {
            body = parseBlock();
          } else if (asExpr) {
            const valExpr = parseExpression();
            body = { type: 'Block', stmts: [{ type: 'Return', value: valExpr, line: valExpr.line, col: valExpr.col }], line: valExpr.line, col: valExpr.col };
          } else {
            const st = parseStatement();
            body = { type: 'Block', stmts: [st], line: st.line || kw.line, col: st.col || kw.col };
          }
          arms.push({ patterns, isDefault, body });
          match('PUNC', ',');
          match('PUNC', ';');
        }
        expect('PUNC', '}', 'Ожидалась "}" в конце match');
        return { type: asExpr ? 'MatchExpr' : 'MatchStmt', subject, arms, line: kw.line, col: kw.col };
      }

      function parseWhile() {
        const kw = expect('KW', 'while');
        const cond = parseExpression();
        const body = parseBlock();
        return { type: 'While', cond, body, line: kw.line, col: kw.col };
      }

      function parseFor() {
        const kw = expect('KW', 'for');
        const varTok = expect('IDENT', undefined, 'Ожидалось имя переменной цикла');
        let secondTok = null;
        if (match('PUNC', ',')) {
          secondTok = expect('IDENT', undefined, 'Ожидалось второе имя переменной цикла (for k, v in ...)');
        }
        expect('KW', 'in', 'Ожидалось ключевое слово "in" после переменной цикла');
        const iterStart = parseExpression();
        if (!secondTok && (isVal('OP', '..') || isVal('OP', '..='))) {
          const inclusive = peek().value === '..=';
          pos++;
          const iterEnd = parseExpression();
          const body = parseBlock();
          return { type: 'ForRange', varName: varTok.value, start: iterStart, end: iterEnd, inclusive, body, line: kw.line, col: kw.col };
        }
        const body = parseBlock();
        if (secondTok) {
          return { type: 'ForEntries', keyName: varTok.value, valName: secondTok.value, iterable: iterStart, body, line: kw.line, col: kw.col };
        }
        return { type: 'ForEach', varName: varTok.value, iterable: iterStart, body, line: kw.line, col: kw.col };
      }

      function parseRepeat() {
        const kw = expect('KW', 'repeat');
        const countExpr = parseExpression();
        const body = parseBlock();
        return { type: 'Repeat', countExpr, body, line: kw.line, col: kw.col };
      }

      function parseReturn() {
        const kw = expect('KW', 'return');
        let value = null;
        if (!isVal('PUNC', ';') && !isVal('PUNC', '}') && !atEnd() && peek().line === kw.line) {
          value = parseExpression();
        }
        match('PUNC', ';');
        return { type: 'Return', value, line: kw.line, col: kw.col };
      }

      function parseExpression() {
        return parseAssign();
      }

      function parseAssign() {
        const left = parseTernary();
        const t = peek();
        if (t.type === 'OP' && ['=', '+=', '-=', '*=', '/=', '%='].includes(t.value)) {
          if (!['Ident', 'Member', 'Index'].includes(left.type)) {
            throw compileError('Недопустимая цель присваивания', t.line, t.col, fileName);
          }
          pos++;
          const right = parseAssign();
          return { type: 'Assign', op: t.value, left, right, line: t.line, col: t.col };
        }
        return left;
      }

      function parseTernary() {
        const cond = parsePipe();
        if (isVal('OP', '?')) {
          const qTok = peek(); pos++;
          const thenExpr = parseAssign();
          expect('PUNC', ':', 'Ожидалось ":" в тернарном выражении ? :');
          const elseExpr = parseAssign();
          return { type: 'Ternary', cond, thenExpr, elseExpr, line: qTok.line, col: qTok.col };
        }
        return cond;
      }

      function parsePipe() {
        let left = parseNullish();
        while (isVal('OP', '|>')) {
          const opTok = peek(); pos++;
          const right = parseNullish();
          if (right.type === 'Call') {
            left = { type: 'Call', callee: right.callee, args: [left, ...right.args], line: opTok.line, col: opTok.col };
          } else {
            left = { type: 'Call', callee: right, args: [left], line: opTok.line, col: opTok.col };
          }
        }
        return left;
      }

      function parseNullish() {
        let left = parseOr();
        while (isVal('OP', '??')) {
          const opTok = peek(); pos++;
          const right = parseOr();
          left = { type: 'Binary', op: '??', left, right, line: opTok.line, col: opTok.col };
        }
        return left;
      }

      function parseOr() {
        let left = parseAnd();
        while (isVal('OP', '||') || isVal('KW', 'or')) {
          const opTok = peek(); pos++;
          const right = parseAnd();
          left = { type: 'Binary', op: '||', left, right, line: opTok.line, col: opTok.col };
        }
        return left;
      }

      function parseAnd() {
        let left = parseEquality();
        while (isVal('OP', '&&') || isVal('KW', 'and')) {
          const opTok = peek(); pos++;
          const right = parseEquality();
          left = { type: 'Binary', op: '&&', left, right, line: opTok.line, col: opTok.col };
        }
        return left;
      }

      function parseEquality() {
        let left = parseComparison();
        while (isVal('OP', '==') || isVal('OP', '!=')) {
          const opTok = peek(); pos++;
          const right = parseComparison();
          left = { type: 'Binary', op: opTok.value === '==' ? '===' : '!==', left, right, line: opTok.line, col: opTok.col };
        }
        return left;
      }

      function parseComparison() {
        let left = parseAdditive();
        while (isVal('OP', '<') || isVal('OP', '<=') || isVal('OP', '>') || isVal('OP', '>=')) {
          const opTok = peek(); pos++;
          const right = parseAdditive();
          left = { type: 'Binary', op: opTok.value, left, right, line: opTok.line, col: opTok.col };
        }
        return left;
      }

      function parseAdditive() {
        let left = parseMultiplicative();
        while (isVal('OP', '+') || isVal('OP', '-')) {
          const opTok = peek(); pos++;
          const right = parseMultiplicative();
          left = { type: 'Binary', op: opTok.value, left, right, line: opTok.line, col: opTok.col };
        }
        return left;
      }

      function parseMultiplicative() {
        let left = parsePower();
        while (isVal('OP', '*') || isVal('OP', '/') || isVal('OP', '%')) {
          const opTok = peek(); pos++;
          const right = parsePower();
          left = { type: 'Binary', op: opTok.value, left, right, line: opTok.line, col: opTok.col };
        }
        return left;
      }

      function parsePower() {
        const left = parseUnary();
        if (isVal('OP', '**')) {
          const opTok = peek(); pos++;
          const right = parsePower();
          return { type: 'Binary', op: '**', left, right, line: opTok.line, col: opTok.col };
        }
        return left;
      }

      function parseArgList() {
        const args = [];
        if (!isVal('PUNC', ')')) {
          do {
            if (match('OP', '...')) {
              const sArg = parseExpression();
              args.push({ type: 'Spread', arg: sArg, line: sArg.line, col: sArg.col });
            } else {
              args.push(parseExpression());
            }
          } while (match('PUNC', ','));
        }
        return args;
      }

      function parseUnary() {
        const t = peek();
        if ((t.type === 'OP' && (t.value === '!' || t.value === '-')) || (t.type === 'KW' && t.value === 'not')) {
          pos++;
          const arg = parseUnary();
          return { type: 'Unary', op: t.value === 'not' ? '!' : t.value, arg, line: t.line, col: t.col };
        }
        if (t.type === 'KW' && t.value === 'await') {
          pos++;
          const arg = parseUnary();
          return { type: 'Await', arg, line: t.line, col: t.col };
        }
        if (t.type === 'KW' && (t.value === 'spawn' || t.value === 'new')) {
          const kind = t.value;
          pos++;
          let ctorExpr = { type: 'Ident', name: expect('IDENT', undefined, `Ожидалось имя сущности после ${kind}`).value, line: t.line, col: t.col };
          while (match('PUNC', '.')) {
            const pt = expect('IDENT', undefined, 'Ожидалось имя сущности после "."');
            ctorExpr = { type: 'Member', obj: ctorExpr, prop: pt.value, line: pt.line, col: pt.col };
          }
          let args = [];
          if (canContinueSameLineExpr() && match('PUNC', '(')) {
            args = parseArgList();
            expect('PUNC', ')', 'Ожидалась ")" после аргументов конструктора');
          }
          return { type: kind === 'spawn' ? 'SpawnExpr' : 'NewExpr', ctorExpr, args, line: t.line, col: t.col };
        }
        return parsePostfix();
      }

      function parsePostfix() {
        let expr = parsePrimary();
        while (true) {
          if (canContinueSameLineExpr() && match('PUNC', '(')) {
            const args = parseArgList();
            expect('PUNC', ')', 'Ожидалась ")" после аргументов вызова');
            expr = { type: 'Call', callee: expr, args, line: expr.line, col: expr.col };
            continue;
          }
          if (match('OP', '?.')) {
            const pt = peek();
            if (pt.type !== 'IDENT' && pt.type !== 'KW') {
              throw compileError('Ожидалось имя поля после "?."', pt.line, pt.col, fileName);
            }
            pos++;
            expr = { type: 'OptMember', obj: expr, prop: pt.value, line: pt.line, col: pt.col };
            continue;
          }
          if (match('PUNC', '.')) {
            const pt = peek();
            if (pt.type !== 'IDENT' && pt.type !== 'KW') {
              throw compileError('Ожидалось имя поля после "."', pt.line, pt.col, fileName);
            }
            pos++;
            expr = { type: 'Member', obj: expr, prop: pt.value, line: pt.line, col: pt.col };
            continue;
          }
          if (canContinueSameLineExpr() && match('PUNC', '[')) {
            const idx = parseExpression();
            expect('PUNC', ']', 'Ожидалась "]" после индекса');
            expr = { type: 'Index', obj: expr, index: idx, line: expr.line, col: expr.col };
            continue;
          }
          if (canContinueSameLineExpr() && (isVal('OP', '++') || isVal('OP', '--'))) {
            const opTok = peek(); pos++;
            if (!['Ident', 'Member', 'Index'].includes(expr.type)) {
              throw compileError('Оператор ' + opTok.value + ' применим только к переменной или полю', opTok.line, opTok.col, fileName);
            }
            expr = { type: 'PostfixOp', op: opTok.value, arg: expr, line: opTok.line, col: opTok.col };
            continue;
          }
          break;
        }
        return expr;
      }

      function isParenArrowAhead() {
        if (!isVal('PUNC', '(')) return false;
        let off = 1;
        let pDepth = 1;
        while (off < 80) {
          const tk = peek(off);
          if (tk.type === 'EOF' || (tk.type === 'PUNC' && tk.value === ';')) return false;
          if (tk.type === 'PUNC' && tk.value === '(') pDepth++;
          else if (tk.type === 'PUNC' && tk.value === ')') {
            pDepth--;
            if (pDepth === 0) {
              return peek(off + 1).type === 'OP' && peek(off + 1).value === '=>';
            }
          }
          off++;
        }
        return false;
      }

      function parseArrowBody() {
        if (isVal('PUNC', '{')) return parseBlock();
        const expr = parseAssign();
        return { type: 'Block', stmts: [{ type: 'Return', value: expr, line: expr.line, col: expr.col }], line: expr.line, col: expr.col };
      }

      function parsePrimary() {
        const t = peek();
        if (t.type === 'NUMBER' || t.type === 'STRING') {
          pos++;
          return { type: 'Literal', value: t.value, line: t.line, col: t.col };
        }
        if (t.type === 'TSTRING') {
          pos++;
          const astParts = t.parts.map(pt => {
            if (pt.kind === 'lit') return { kind: 'lit', value: pt.value };
            const subToks = tokenize(pt.code, pt.line, pt.col, fileName);
            const subExpr = parseTokenStream(subToks, 'expr');
            return { kind: 'expr', node: subExpr };
          });
          return { type: 'InterpString', parts: astParts, line: t.line, col: t.col };
        }
        if (t.type === 'SIZE') {
          pos++;
          return { type: 'SizeLiteral', width: t.width, height: t.height, line: t.line, col: t.col };
        }
        if (t.type === 'DURATION') {
          pos++;
          return { type: 'Literal', value: t.ms, line: t.line, col: t.col };
        }
        if (t.type === 'KW') {
          if (t.value === 'true') { pos++; return { type: 'Literal', value: true, line: t.line, col: t.col }; }
          if (t.value === 'false') { pos++; return { type: 'Literal', value: false, line: t.line, col: t.col }; }
          if (t.value === 'null') { pos++; return { type: 'Literal', value: null, line: t.line, col: t.col }; }
          if (t.value === 'game') { pos++; return { type: 'Ident', name: 'game', line: t.line, col: t.col }; }
          if (t.value === 'super') { pos++; return { type: 'Ident', name: 'super', line: t.line, col: t.col }; }
          if (t.value === 'this' || t.value === 'self') { pos++; return { type: 'Ident', name: 'this', line: t.line, col: t.col }; }
          if (t.value === 'match') return parseMatch(true);
          if (t.value === 'fn') {
            pos++;
            const params = parseParamDefs(true);
            let body = null;
            if (match('OP', '=>')) {
              body = parseArrowBody();
            } else {
              body = parseBlock();
            }
            return { type: 'FnExpr', params, body, line: t.line, col: t.col };
          }
        }
        if (t.type === 'IDENT') {
          if (t.value === 'function' && peek(1).type === 'PUNC' && peek(1).value === '(') {
            pos++;
            const params = parseParamDefs(true);
            let body = null;
            if (match('OP', '=>')) {
              body = parseArrowBody();
            } else {
              body = parseBlock();
            }
            return { type: 'FnExpr', params, body, usedJsFunction: true, line: t.line, col: t.col };
          }
          if (peek(1).type === 'OP' && peek(1).value === '=>') {
            pos += 2;
            const body = parseArrowBody();
            return { type: 'FnExpr', params: [{ name: t.value, defVal: null }], body, line: t.line, col: t.col };
          }
          pos++;
          return { type: 'Ident', name: t.value, line: t.line, col: t.col };
        }
        if (isParenArrowAhead()) {
          const params = parseParamDefs(true);
          expect('OP', '=>');
          const body = parseArrowBody();
          return { type: 'FnExpr', params, body, line: t.line, col: t.col };
        }
        if (match('PUNC', '(')) {
          const inner = parseExpression();
          expect('PUNC', ')', 'Ожидалась закрывающая скобка ")"');
          return inner;
        }
        if (match('PUNC', '[')) {
          const items = [];
          while (!isVal('PUNC', ']') && !atEnd()) {
            if (match('OP', '...')) {
              const sArg = parseExpression();
              items.push({ type: 'Spread', arg: sArg, line: sArg.line, col: sArg.col });
            } else {
              items.push(parseExpression());
            }
            if (!match('PUNC', ',')) break;
          }
          expect('PUNC', ']', 'Ожидалась закрывающая скобка "]"');
          return { type: 'ArrayLit', items, line: t.line, col: t.col };
        }
        if (match('PUNC', '{')) {
          const entries = [];
          while (!isVal('PUNC', '}') && !atEnd()) {
            if (match('PUNC', ',')) continue;
            if (match('OP', '...')) {
              const sArg = parseExpression();
              entries.push({ spread: true, val: sArg });
              match('PUNC', ',');
              continue;
            }
            if (match('PUNC', '[')) {
              const kExpr = parseExpression();
              expect('PUNC', ']', 'Ожидалась "]" после вычисляемого ключа объекта');
              expect('PUNC', ':', 'Ожидалось ":" после ключа объекта');
              const val = parseExpression();
              entries.push({ computed: true, keyExpr: kExpr, val });
              match('PUNC', ',');
              continue;
            }
            const kt = peek();
            let kStr = '';
            if (kt.type === 'IDENT' || kt.type === 'STRING' || kt.type === 'KW') {
              kStr = kt.value;
              pos++;
            } else {
              throw compileError('Ожидался ключ объекта', kt.line, kt.col, fileName);
            }
            if (kt.type === 'IDENT' && !isVal('PUNC', ':')) {
              entries.push({ key: kStr, val: { type: 'Ident', name: kStr, line: kt.line, col: kt.col } });
            } else {
              expect('PUNC', ':', 'Ожидалось ":" после ключа объекта');
              const val = parseExpression();
              entries.push({ key: kStr, val });
            }
            match('PUNC', ',');
          }
          expect('PUNC', '}', 'Ожидалась закрывающая скобка "}"');
          return { type: 'ObjectLit', entries, line: t.line, col: t.col };
        }

        throw compileError(`Неожиданный токен "${t.value || t.type}"`, t.line, t.col, fileName);
      }

      if (entryMode === 'expr') {
        const expr = parseExpression();
        if (!atEnd()) {
          const extra = peek();
          throw compileError(`Лишний токен "${extra.value || extra.type}" в выражении`, extra.line, extra.col, fileName);
        }
        return expr;
      }
      return parseProgram();
    }

    return parseTokenStream(tokens, 'program');
  }

  function calleeChainName(node) {
    if (!node) return '';
    if (node.type === 'Ident') return node.name;
    if (node.type === 'Member' || node.type === 'OptMember') {
      const base = calleeChainName(node.obj);
      return base ? `${base}.${node.prop}` : '';
    }
    return '';
  }

  function normalizeRelPath(p) {
    const parts = String(p || '').replace(/\\/g, '/').split('/');
    const stack = [];
    for (const seg of parts) {
      if (!seg || seg === '.') continue;
      if (seg === '..') {
        if (stack.length > 0) stack.pop();
      } else {
        stack.push(seg);
      }
    }
    return stack.join('/');
  }

  function resolveImportFile(fromFile, reqPath, filesMap) {
    const clean = String(reqPath || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
    const dir = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : '';
    const candidates = [
      normalizeRelPath((dir ? dir + '/' : '') + clean),
      normalizeRelPath(clean),
      normalizeRelPath((dir ? dir + '/' : '') + clean + '.roy'),
      normalizeRelPath(clean + '.roy')
    ];
    for (const c of candidates) {
      if (filesMap[c] && typeof filesMap[c].content === 'string') return c;
    }
    return null;
  }

  function compileAst(ast, assetManifest) {
    const meta = {
      title: 'RoyLang Игра',
      width: 800,
      height: 500,
      bg: '#090d16',
      fps: 60,
      pixelated: false,
      scaleMode: 'fit',
      gamepad: null,
      locale: 'ru'
    };

    if (ast.gameHeader) {
      if (ast.gameHeader.title) meta.title = ast.gameHeader.title;
      const p = ast.gameHeader.props || {};
      if (p.title && p.title.type === 'Literal') meta.title = String(p.title.value);
      if (p.width && p.width.type === 'Literal' && Number(p.width.value) >= 120) meta.width = Math.min(4096, Number(p.width.value));
      if (p.height && p.height.type === 'Literal' && Number(p.height.value) >= 120) meta.height = Math.min(4096, Number(p.height.value));
      if (p.size && p.size.type === 'SizeLiteral') {
        meta.width = Math.max(120, Math.min(4096, p.size.width));
        meta.height = Math.max(120, Math.min(4096, p.size.height));
      }
      if (p.bg && p.bg.type === 'Literal') meta.bg = String(p.bg.value);
      if (p.fps && p.fps.type === 'Literal' && Number(p.fps.value) > 0) meta.fps = Math.max(10, Math.min(120, Number(p.fps.value)));
      if (p.pixelated && p.pixelated.type === 'Literal') meta.pixelated = !!p.pixelated.value;
      if (p.scale && p.scale.type === 'Literal') meta.scaleMode = String(p.scale.value).toLowerCase();
      if (p.gamepad && p.gamepad.type === 'Literal') meta.gamepad = !!p.gamepad.value;
      if (p.locale && p.locale.type === 'Literal') meta.locale = String(p.locale.value || 'ru').toLowerCase();
    }

    const asyncFnNames = new Set();
    function astHasAwait(node) {
      if (!node || typeof node !== 'object') return false;
      if (node.type === 'Await') return true;
      if (node.type === 'Call') {
        const name = calleeChainName(node.callee);
        if (ASYNC_ROOTS.has(name) || ASYNC_MEMBERS.has(name) || asyncFnNames.has(name)) return true;
      }
      if (node.type === 'FnExpr' || node.type === 'FnDecl' || node.type === 'TaskDecl') return false;
      for (const k of Object.keys(node)) {
        const v = node[k];
        if (Array.isArray(v)) {
          for (const item of v) {
            if (item && typeof item === 'object' && astHasAwait(item)) return true;
          }
        } else if (v && typeof v === 'object' && v.type) {
          if (astHasAwait(v)) return true;
        }
      }
      return false;
    }

    const topFns = [];
    function collectTopFns(stmts) {
      (stmts || []).forEach(s => {
        if (!s) return;
        if (s.type === 'FnDecl') topFns.push(s);
        else if (s.type === 'ModuleScope') collectTopFns(s.body);
      });
    }
    collectTopFns(ast.body);

    for (let pass = 0; pass <= topFns.length; pass++) {
      let changed = false;
      for (const fnNode of topFns) {
        if (!asyncFnNames.has(fnNode.name) && astHasAwait(fnNode.body)) {
          asyncFnNames.add(fnNode.name);
          changed = true;
        }
      }
      if (!changed) break;
    }

    function shouldAutoAwait(calleeNode) {
      const name = calleeChainName(calleeNode);
      if (!name) return false;
      return ASYNC_ROOTS.has(name) || ASYNC_MEMBERS.has(name) || asyncFnNames.has(name);
    }

    const KNOWN_RUNTIME_GLOBALS = new Set([
      'BaseEntity', 'spawn', 'entities', 'destroyAll', 'drawEntities', 'on', 'every', 'after', 'wait',
      'spawnTask', 'cancelTasks', 'setState',
      'loadImage', 'loadSound', 'loadJson', 'tilemap', 'tileMask', 'panel9', 'moveAndCollide', 'moveCircle', 'raycast', 'lineOfSight', 'bounceCircle', 'spatialQuery',
      'steerSeek', 'steerArrive', 'steerSeparate',
      'button', 'panel', 'hovered', 'vbox', 'hbox', 'layoutEnd', 'scrollView', 'uiButton', 'uiLabel', 'uiPanel',
      'setLocale', 'getLocale', 'addTranslations', 't',
      'scrollBegin', 'scrollEnd', 'slider', 'toggle', 'pathfind', 'pathfindAsync', 'flowField',
      'drawGradient', 'drawRadialGradient', 'layer', 'beginScreen', 'beginWorld', 'zoomAt',
      'pushMatrix', 'popMatrix', 'translate', 'rotate', 'scale', 'clip', 'unclip', 'consumeClick', 'setCursor',
      'setGamepad', 'gamepad', 'rumble', 'vibrate', 'bind', 'unbind', 'action', 'actionPressed', 'actionReleased',
      'lockPointer', 'unlockPointer', 'pointerLocked', 'gesture', 'swipe', 'pinchZoom', 'doubleTap',
      'freezeFrame', 'hitStop', 'flashScreen', 'timeScale',
      'fx', 'setShader', 'shockwave', 'weather', 'waterZone', 'ambientLight', 'light', 'shadowLight', 'coneLight', 'shadowCasters',
      'setBlend', 'setShadow', 'resetShadow', 'drawTrail', 'ropeChain', 'limbIK', 'debug',
      'scene', 'goto', 'pushScene', 'popScene', 'tween', 'vec', 'sprite', 'anim', 'pool', 'fogOfWar', 'ragdoll',
      'game', 'mouse', 'touches', 'player', 'RoySDK', 'world', 'rooms', 'netSync',
      'save', 'load', 'submitScore', 'topScores', 'toast', 'openDonate', 'setBadge', 'dialogue', 'uiGrid', 'tooltip', 'cls', 'clear',
      'ghostRecord', 'ghostStop', 'ghostPlay',
      'rect', 'circle', 'drawObj', 'drawRect', 'strokeRect', 'drawCircle', 'strokeCircle',
      'drawArc', 'drawRing', 'drawEllipse', 'drawLine', 'drawPoly', 'drawPath', 'drawCurve', 'drawBezier',
      'drawStar', 'drawBar', 'drawGrid', 'pixel', 'setFont', 'text', 'textStroke', 'textWrap', 'measureText',
      'glow', 'resetGlow', 'alpha', 'blend', 'particles', 'emitParticles',
      'camera', 'getCamera', 'camX', 'camY', 'camZoom', 'inView', 'cameraFollow', 'cameraBounds', 'shake', 'key', 'keyPressed', 'axis',
      'sfx', 'synth', 'tone', 'playNote', 'melody', 'bgm', 'syncBgm', 'stopBgm', 'setReverb', 'setMuted', 'isMuted', 'now',
      'abs', 'min', 'max', 'clamp', 'lerp', 'wrap', 'sign', 'approach', 'range',
      'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'sqrt', 'pow', 'floor', 'ceil', 'round', 'roundTo',
      'log10', 'exp', 'PI', 'TAU', 'noise2d', 'fbm', 'hsl', 'lerpColor',
      'fmtNum', 'int', 'float', 'str', 'num', 'bool', 'rand', 'randInt', 'random', 'choose',
      'len', 'push', 'pop', 'removeAt', 'map', 'filter', 'find', 'some', 'everyItem', 'reduce', 'sort', 'slice',
      'reverse', 'contains', 'indexOf', 'flat', 'split', 'join', 'trim', 'upper', 'lower', 'replace', 'keys', 'values',
      'dist', 'collides', 'print', 'log',
      'Math', 'Date', 'JSON', 'Array', 'Object', 'Number', 'String', 'Boolean', 'Promise', 'RegExp', 'Map', 'Set',
      'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'console', 'window', 'document'
    ]);

    function levenshteinDist(a, b) {
      const m = a.length, n = b.length;
      if (!m) return n;
      if (!n) return m;
      const dp = new Array(n + 1);
      for (let j = 0; j <= n; j++) dp[j] = j;
      for (let i = 1; i <= m; i++) {
        let prev = dp[0];
        dp[0] = i;
        for (let j = 1; j <= n; j++) {
          const tmp = dp[j];
          dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
          prev = tmp;
        }
      }
      return dp[n];
    }

    function suggestClosestSymbol(name, scopeSet) {
      const target = String(name || '');
      const lower = target.toLowerCase();
      let best = '';
      let bestScore = Infinity;
      const checkSet = (s) => {
        s.forEach(cand => {
          if (!cand || cand === target || cand.length < 2) return;
          const d = levenshteinDist(lower, cand.toLowerCase());
          const maxAllow = Math.max(2, Math.floor(Math.max(target.length, cand.length) * 0.45));
          if (d <= maxAllow && d < bestScore) {
            bestScore = d;
            best = cand;
          }
        });
      };
      checkSet(KNOWN_RUNTIME_GLOBALS);
      if (scopeSet) checkSet(scopeSet);
      return best;
    }

    function addPatternNames(pat, set) {
      if (!pat) return;
      if (pat.type === 'ArrayPat') (pat.elements || []).forEach(el => { if (el.name) set.add(el.name); });
      else if (pat.type === 'ObjectPat') (pat.props || []).forEach(pr => { if (pr.alias) set.add(pr.alias); });
    }

    function addParamNames(params, set) {
      (params || []).forEach(p => {
        if (typeof p === 'string') set.add(p);
        else if (p && p.pattern) addPatternNames(p.pattern, set);
        else if (p && p.name) set.add(p.name);
      });
    }

    function collectDeclaredInStmts(stmts, set) {
      (stmts || []).forEach(s => {
        if (!s) return;
        if (s.type === 'VarDecl') {
          if (s.name) set.add(s.name);
          if (s.pattern) addPatternNames(s.pattern, set);
        } else if (s.type === 'FnDecl' || s.type === 'TaskDecl' || s.type === 'ClassDecl' || s.type === 'EntityDecl' || s.type === 'EnumDecl') {
          if (s.name) set.add(s.name);
        } else if (s.type === 'ImportBinding') {
          if (s.mode === 'namespace' && s.nsAlias) set.add(s.nsAlias);
          else if (s.mode === 'named') (s.specifiers || []).forEach(sp => set.add(sp.alias));
        }
      });
    }

    const declaredScenes = new Set(['main']);
    const declaredLocalEntities = [];
    const referencedIdents = new Set();

    function collectPreFlightMeta(node, fName, inOwnEntityDeclName) {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'ModuleScope') {
        const mf = node.fileName || fName;
        (node.body || []).forEach(s => collectPreFlightMeta(s, mf, null));
        return;
      }
      if (node.type === 'OnHook' && node.sceneFilter) {
        declaredScenes.add(node.sceneFilter);
      }
      if (node.type === 'EntityDecl') {
        if (!node.exported && node.name) {
          declaredLocalEntities.push({ name: node.name, file: fName, line: node.line });
        }
        if (node.superName) referencedIdents.add(node.superName);
        if (node.initMethod) collectPreFlightMeta(node.initMethod, fName, node.name);
        (node.methods || []).forEach(m => collectPreFlightMeta(m, fName, node.name));
        (node.fields || []).forEach(f => { if (f.init) collectPreFlightMeta(f.init, fName, node.name); });
        (node.states || []).forEach(st => {
          Object.values(st.handlers || {}).forEach(h => collectPreFlightMeta(h.body, fName, node.name));
        });
        (node.entityTimers || []).forEach(et => {
          collectPreFlightMeta(et.msExpr, fName, node.name);
          collectPreFlightMeta(et.body, fName, node.name);
        });
        return;
      }
      if (node.type === 'ClassDecl' && node.superName) {
        referencedIdents.add(node.superName);
      }
      if (node.type === 'Ident' && node.name !== inOwnEntityDeclName) {
        referencedIdents.add(node.name);
      }
      for (const k of Object.keys(node)) {
        const v = node[k];
        if (Array.isArray(v)) v.forEach(item => collectPreFlightMeta(item, fName, inOwnEntityDeclName));
        else if (v && typeof v === 'object' && v.type) collectPreFlightMeta(v, fName, inOwnEntityDeclName);
      }
    }

    let curFile = ast.fileName || 'main.roy';
    collectPreFlightMeta(ast, curFile, null);

    const warnings = [];
    const baseScope = new Set(KNOWN_RUNTIME_GLOBALS);
    (assetManifest || []).forEach(a => baseScope.add(a.alias));
    collectDeclaredInStmts(ast.body, baseScope);

    function suggestFromSet(name, candidatesSet) {
      const target = String(name || '');
      const lower = target.toLowerCase();
      let best = '';
      let bestScore = Infinity;
      candidatesSet.forEach(cand => {
        if (!cand || cand === target) return;
        const d = levenshteinDist(lower, String(cand).toLowerCase());
        const maxAllow = Math.max(2, Math.floor(Math.max(target.length, String(cand).length) * 0.5));
        if (d <= maxAllow && d < bestScore) { bestScore = d; best = cand; }
      });
      return best;
    }

    function lintWalk(node, fName, scopeSet) {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'ModuleScope') {
        const mf = node.fileName || fName;
        const modScope = new Set(KNOWN_RUNTIME_GLOBALS);
        (assetManifest || []).forEach(a => modScope.add(a.alias));
        collectDeclaredInStmts(node.body, modScope);
        (node.body || []).forEach(s => lintWalk(s, mf, modScope));
        return;
      }
      if (node.type === 'FnDecl' || node.type === 'FnExpr' || node.type === 'TaskDecl') {
        if (node.usedJsFunction) {
          warnings.push(`[${fName}:${node.line}] В RoyLang принято писать "fn" вместо "function" (работает как алиас)`);
        }
        const fnScope = new Set(scopeSet);
        addParamNames(node.params, fnScope);
        if (node.body && node.body.stmts) collectDeclaredInStmts(node.body.stmts, fnScope);
        lintWalk(node.body, fName, fnScope);
        return;
      }
      if (node.type === 'ClassDecl' || node.type === 'EntityDecl') {
        const clsScope = new Set(scopeSet);
        addParamNames(node.ctorParams, clsScope);
        if (node.initMethod) lintWalk(node.initMethod, fName, clsScope);
        (node.methods || []).forEach(m => lintWalk(m, fName, clsScope));
        (node.fields || []).forEach(f => { if (f.init) lintWalk(f.init, fName, clsScope); });
        (node.states || []).forEach(st => {
          Object.values(st.handlers || {}).forEach(h => {
            const stScope = new Set(clsScope);
            addParamNames(h.params, stScope);
            if (h.body && h.body.stmts) collectDeclaredInStmts(h.body.stmts, stScope);
            lintWalk(h.body, fName, stScope);
          });
        });
        (node.entityTimers || []).forEach(et => {
          lintWalk(et.msExpr, fName, clsScope);
          lintWalk(et.body, fName, clsScope);
        });
        return;
      }
      if (node.type === 'OnHook') {
        const hookScope = new Set(scopeSet);
        addParamNames(node.params, hookScope);
        if (node.body && node.body.stmts) collectDeclaredInStmts(node.body.stmts, hookScope);
        lintWalk(node.body, fName, hookScope);
        return;
      }
      if (node.type === 'Block') {
        const blkScope = new Set(scopeSet);
        collectDeclaredInStmts(node.stmts, blkScope);
        (node.stmts || []).forEach(s => lintWalk(s, fName, blkScope));
        return;
      }
      if (node.type === 'ForRange' || node.type === 'ForEach') {
        lintWalk(node.start, fName, scopeSet);
        lintWalk(node.end, fName, scopeSet);
        lintWalk(node.iterable, fName, scopeSet);
        const loopScope = new Set(scopeSet);
        if (node.varName) loopScope.add(node.varName);
        if (node.body && node.body.stmts) collectDeclaredInStmts(node.body.stmts, loopScope);
        lintWalk(node.body, fName, loopScope);
        return;
      }
      if (node.type === 'ForEntries') {
        lintWalk(node.iterable, fName, scopeSet);
        const loopScope = new Set(scopeSet);
        if (node.keyName) loopScope.add(node.keyName);
        if (node.valName) loopScope.add(node.valName);
        if (node.body && node.body.stmts) collectDeclaredInStmts(node.body.stmts, loopScope);
        lintWalk(node.body, fName, loopScope);
        return;
      }
      if (node.type === 'Call') {
        const chain = calleeChainName(node.callee);
        if (node.callee && node.callee.type === 'Ident') {
          const cn = node.callee.name;
          if (cn === 'random') {
            warnings.push(`[${fName}:${node.line}] random() поддерживается для совместимости; стандартные функции RoyLang — rand() и randInt()`);
          } else if (cn === 'randomInt') {
            warnings.push(`[${fName}:${node.line}] Неизвестная функция "randomInt". Возможно, имелось в виду "randInt"?`);
          } else if (!scopeSet.has(cn)) {
            const sug = suggestClosestSymbol(cn, scopeSet);
            warnings.push(`[${fName}:${node.line}] Неизвестная функция "${cn}"${sug ? `. Возможно, имелось в виду "${sug}"?` : ''}`);
          }
        }
        if ((chain === 'goto' || chain === 'pushScene' || chain === 'scene.goto' || chain === 'scene.is') &&
            node.args && node.args[0] && node.args[0].type === 'Literal' && typeof node.args[0].value === 'string') {
          const targetSc = node.args[0].value;
          if (!declaredScenes.has(targetSc)) {
            const sugSc = suggestFromSet(targetSc, declaredScenes);
            warnings.push(`[${fName}:${node.line}] Сцена "${targetSc}" не объявлена в хуках on ... "${targetSc}"${sugSc ? `. Возможно, имелось в виду "${sugSc}"?` : ''}`);
          }
        }
        if (chain === 'textStroke' && node.args && node.args[3] && node.args[3].type === 'Literal' && typeof node.args[3].value === 'number') {
          warnings.push(`[${fName}:${node.line}] В textStroke 4-й аргумент — цвет текста (или объект { color, stroke, size }), а size идёт 6-м`);
        }
      } else if ((node.type === 'NewExpr' || node.type === 'SpawnExpr') && node.ctorExpr && node.ctorExpr.type === 'Ident') {
        const cn = node.ctorExpr.name;
        if (!scopeSet.has(cn)) {
          const sug = suggestClosestSymbol(cn, scopeSet);
          warnings.push(`[${fName}:${node.line}] Неизвестный класс/сущность "${cn}"${sug ? `. Возможно, имелось в виду "${sug}"?` : ''}`);
        }
      }
      for (const k of Object.keys(node)) {
        const v = node[k];
        if (Array.isArray(v)) v.forEach(item => lintWalk(item, fName, scopeSet));
        else if (v && typeof v === 'object' && v.type) lintWalk(v, fName, scopeSet);
      }
    }
    lintWalk(ast, curFile, baseScope);
    declaredLocalEntities.forEach(entInfo => {
      if (!referencedIdents.has(entInfo.name)) {
        warnings.push(`[${entInfo.file}:${entInfo.line}] Сущность "${entInfo.name}" объявлена, но нигде не создаётся (spawn ${entInfo.name}(...))`);
      }
    });

    let seq = 0;
    const nextTmp = (p) => `__roy_${p}_${++seq}`;
    let emitTaskDepth = 0;
    let emitInEntityMethod = false;

    function emitParams(params) {
      return (params || []).map(p => {
        if (typeof p === 'string') return p;
        if (p.pattern) {
          let patStr = '';
          if (p.pattern.type === 'ObjectPat') {
            patStr = `{ ${p.pattern.props.map(pr => `${pr.key}: ${pr.alias}${pr.defVal ? ` = ${emitExpr(pr.defVal)}` : ''}`).join(', ')} }`;
          } else {
            patStr = `[${p.pattern.elements.map(el => el.rest ? `...${el.name}` : (el.defVal ? `${el.name} = ${emitExpr(el.defVal)}` : el.name)).join(', ')}]`;
          }
          return p.defVal ? `${patStr} = ${emitExpr(p.defVal)}` : patStr;
        }
        if (p.rest) return `...${p.name}`;
        return p.defVal ? `${p.name} = ${emitExpr(p.defVal)}` : p.name;
      }).join(', ');
    }

    function emitMatchCond(subVar, patterns) {
      const checks = patterns.map(pt => {
        if (pt.kind === 'wildcard') return 'true';
        if (pt.kind === 'range') {
          const cmp = pt.inclusive ? '<=' : '<';
          return `(${subVar} >= ${emitExpr(pt.start)} && ${subVar} ${cmp} ${emitExpr(pt.end)})`;
        }
        return `(${subVar} === ${emitExpr(pt.expr)})`;
      });
      return checks.join(' || ');
    }

    function emitMatchBody(node, isExprMode) {
      const subVar = nextTmp('m');
      const hasAsync = astHasAwait(node);
      const branches = [];
      let hitWildcard = false;
      for (let idx = 0; idx < node.arms.length; idx++) {
        const arm = node.arms[idx];
        const prefix = idx === 0 ? 'if' : 'else if';
        if (arm.isDefault && arm.patterns.length === 1 && arm.patterns[0].kind === 'wildcard') {
          branches.push(`${idx === 0 ? '' : 'else '}${emitBlock(arm.body)}`);
          hitWildcard = true;
          break;
        }
        const cond = emitMatchCond(subVar, arm.patterns);
        branches.push(`${prefix} (${cond}) ${emitBlock(arm.body)}`);
      }
      const chain = branches.join(' ');
      if (!isExprMode) {
        return `{ const ${subVar} = ${emitExpr(node.subject)}; ${chain} }`;
      }
      const fallbackRet = hitWildcard ? '' : ' return null;';
      if (hasAsync) {
        return `(await (async function(${subVar}){ ${chain}${fallbackRet} })(${emitExpr(node.subject)}))`;
      }
      return `((function(${subVar}){ ${chain}${fallbackRet} })(${emitExpr(node.subject)}))`;
    }

    function emitExpr(node, forceNoAwait = false) {
      if (!node) return 'null';
      switch (node.type) {
        case 'Literal': return JSON.stringify(node.value);
        case 'SizeLiteral': return JSON.stringify({ width: node.width, height: node.height });
        case 'Ident': return node.name;
        case 'Spread': return `...${emitExpr(node.arg)}`;
        case 'InterpString': {
          const segs = node.parts.map(pt => pt.kind === 'lit' ? JSON.stringify(pt.value) : `String(${emitExpr(pt.node)})`);
          return segs.length ? `(${segs.join(' + ')})` : '""';
        }
        case 'ArrayLit': return `[${node.items.map(x => emitExpr(x)).join(', ')}]`;
        case 'ObjectLit':
          return `({ ${node.entries.map(e => e.spread ? `...(${emitExpr(e.val)})` : (e.computed ? `[${emitExpr(e.keyExpr)}]: ${emitExpr(e.val)}` : `${JSON.stringify(e.key)}: ${emitExpr(e.val)}`)).join(', ')} })`;
        case 'Member': return `${emitExpr(node.obj)}[${JSON.stringify(node.prop)}]`;
        case 'OptMember': return `${emitExpr(node.obj)}?.[${JSON.stringify(node.prop)}]`;
        case 'Index': return `${emitExpr(node.obj)}[${emitExpr(node.index)}]`;
        case 'Unary': return `(${node.op}${emitExpr(node.arg)})`;
        case 'Await': return `(await ${emitExpr(node.arg, true)})`;
        case 'PostfixOp': return `(${emitExpr(node.arg)}${node.op})`;
        case 'Ternary': return `(${emitExpr(node.cond)} ? ${emitExpr(node.thenExpr)} : ${emitExpr(node.elseExpr)})`;
        case 'Binary': return `(${emitExpr(node.left)} ${node.op} ${emitExpr(node.right)})`;
        case 'Assign': return `(${emitExpr(node.left)} ${node.op} ${emitExpr(node.right)})`;
        case 'MatchExpr': return emitMatchBody(node, true);
        case 'NewExpr': return `new (${emitExpr(node.ctorExpr)})(${node.args.map(a => emitExpr(a)).join(', ')})`;
        case 'SpawnExpr': return `__rt.spawn(new (${emitExpr(node.ctorExpr)})(${node.args.map(a => emitExpr(a)).join(', ')}))`;
        case 'FnExpr': {
          const prevTask = emitTaskDepth;
          const prevEnt = emitInEntityMethod;
          emitTaskDepth = 0;
          emitInEntityMethod = false;
          const fnAsync = astHasAwait(node.body);
          const codeStr = `(${fnAsync ? 'async ' : ''}function(${emitParams(node.params)}) ${emitBlock(node.body)})`;
          emitTaskDepth = prevTask;
          emitInEntityMethod = prevEnt;
          return codeStr;
        }
        case 'Call': {
          const callStr = `${emitExpr(node.callee)}(${node.args.map(a => emitExpr(a)).join(', ')})`;
          if (!forceNoAwait && shouldAutoAwait(node.callee)) {
            return `(await ${callStr})`;
          }
          return callStr;
        }
        default:
          throw compileError('Неподдерживаемое выражение: ' + node.type, node.line || 1, node.col || 1);
      }
    }

    function locTag(s) {
      if (!s || !s.line) return '';
      if (s.type === 'ModuleScope' || s.type === 'ImportBinding' || s.type === 'ReExportDecl' || s.type === 'LocalExportList' || s.type === 'EnumDecl' || s.type === 'FnDecl' || s.type === 'TaskDecl' || s.type === 'ClassDecl' || s.type === 'EntityDecl') return '';
      return `__rt._loc = ${JSON.stringify(curFile + ':' + s.line)}; `;
    }

    function emitBlock(blockNode) {
      return `{\n${blockNode.stmts.map(s => locTag(s) + emitStmt(s)).join('\n')}\n}`;
    }

    function emitStatesSetup(statesList) {
      if (!statesList || statesList.length === 0) return '';
      const defName = statesList[0].name;
      const entriesJs = statesList.map(st => {
        const hEntries = Object.keys(st.handlers || {}).map(hk => {
          const h = st.handlers[hk];
          const isAsync = astHasAwait(h.body);
          const prevEnt = emitInEntityMethod;
          const prevTask = emitTaskDepth;
          emitInEntityMethod = true;
          emitTaskDepth = 0;
          const fnCode = `${isAsync ? 'async ' : ''}(${emitParams(h.params)}) => ${emitBlock(h.body)}`;
          emitInEntityMethod = prevEnt;
          emitTaskDepth = prevTask;
          return `${JSON.stringify(hk)}: ${fnCode}`;
        });
        return `${JSON.stringify(st.name)}: { ${hEntries.join(', ')} }`;
      });
      return `this.state = ${JSON.stringify(defName)};\nthis.stateTime = 0;\nthis._states = { ${entriesJs.join(', ')} };`;
    }

    function emitEntityTimersSetup(timerList) {
      if (!timerList || timerList.length === 0) return '';
      const prevEnt = emitInEntityMethod;
      emitInEntityMethod = true;
      const code = timerList.map(t => {
        const isAsync = astHasAwait(t.body);
        const fnKind = t.type === 'EveryHook' ? 'every' : 'after';
        return `__rt.${fnKind}(${emitExpr(t.msExpr)}, ${isAsync ? 'async ' : ''}() => ${emitBlock(t.body)}, this);`;
      }).join('\n');
      emitInEntityMethod = prevEnt;
      return code;
    }

    function emitStmt(node) {
      if (!node) return '';
      switch (node.type) {
        case 'Block': return emitBlock(node);
        case 'ReExportDecl':
        case 'LocalExportList':
          return '';
        case 'ModuleScope': {
          const prevF = curFile;
          if (node.fileName) curFile = node.fileName;
          const innerCode = node.body.map(s => emitStmt(s)).join('\n');
          curFile = prevF;
          const ownPairs = (node.exportsList || []).map(n => `${JSON.stringify(n)}: ${n}`);
          const rePairs = (node.reExports || []).map(re => `${JSON.stringify(re.exportName)}: ${re.sourceModVar}[${JSON.stringify(re.sourceName)}]`);
          const expObj = `{ ${ownPairs.concat(rePairs).join(', ')} }`;
          const hasAsyncMod = node.body.some(s => astHasAwait(s));
          const fnWrap = hasAsyncMod
            ? `(await (async function(){\n${innerCode}\nreturn ${expObj};\n})())`
            : `((function(){\n${innerCode}\nreturn ${expObj};\n})())`;
          return `const ${node.modVar} = ${fnWrap};`;
        }
        case 'ImportBinding': {
          if (node.mode === 'namespace') {
            return `const ${node.nsAlias} = ${node.modVar};`;
          }
          if (node.mode === 'named') {
            const pairs = node.specifiers.map(sp => `${sp.name}: ${sp.alias}`).join(', ');
            return `const { ${pairs} } = ${node.modVar};`;
          }
          return '';
        }
        case 'VarDecl': {
          const kw = node.kind === 'const' ? 'const' : 'let';
          if (node.pattern) {
            if (node.pattern.type === 'ArrayPat') {
              const elems = node.pattern.elements.map(el => el.rest ? `...${el.name}` : (el.defVal ? `${el.name} = ${emitExpr(el.defVal)}` : el.name)).join(', ');
              return `${kw} [${elems}] = ${emitExpr(node.init)};`;
            }
            if (node.pattern.type === 'ObjectPat') {
              const props = node.pattern.props.map(pr => `${pr.key}: ${pr.alias}${pr.defVal ? ` = ${emitExpr(pr.defVal)}` : ''}`).join(', ');
              return `${kw} { ${props} } = ${emitExpr(node.init)};`;
            }
          }
          return `${kw} ${node.name} = ${node.init ? emitExpr(node.init) : 'null'};`;
        }
        case 'FnDecl': {
          const prevTask = emitTaskDepth;
          const prevEnt = emitInEntityMethod;
          emitTaskDepth = 0;
          emitInEntityMethod = false;
          const isAsync = asyncFnNames.has(node.name) || astHasAwait(node.body);
          const out = `${isAsync ? 'async ' : ''}function ${node.name}(${emitParams(node.params)}) ${emitBlock(node.body)}`;
          emitTaskDepth = prevTask;
          emitInEntityMethod = prevEnt;
          return out;
        }
        case 'TaskDecl': {
          const prevTask = emitTaskDepth;
          const prevEnt = emitInEntityMethod;
          emitTaskDepth = 1;
          emitInEntityMethod = false;
          const inner = emitBlock(node.body);
          emitTaskDepth = prevTask;
          emitInEntityMethod = prevEnt;
          return `function ${node.name}(${emitParams(node.params)}) { return __rt._runTask(null, async function(__royTask) ${inner}); }`;
        }
        case 'EnumDecl': {
          let counter = 0;
          const propsOut = node.entries.map(en => {
            if (en.val) {
              if (en.val.type === 'Literal' && typeof en.val.value === 'number') counter = en.val.value + 1;
              return `${JSON.stringify(en.name)}: ${emitExpr(en.val)}`;
            }
            return `${JSON.stringify(en.name)}: ${counter++}`;
          }).join(', ');
          return `const ${node.name} = Object.freeze({ ${propsOut} });`;
        }
        case 'ClassDecl': {
          const ctorParamList = emitParams(node.ctorParams);
          const superArgs = node.ctorParams.filter(p => p.name && !p.rest).map(p => p.name).join(', ');
          const superStmt = node.superName ? `super(${superArgs}); ` : '';
          const assignParams = node.ctorParams.filter(p => p.name).map(p => `this[${JSON.stringify(p.name)}] = ${p.name};`).join(' ');
          const fieldInits = node.fields.map(f => `this[${JSON.stringify(f.name)}] = ${f.init ? emitExpr(f.init) : 'null'};`).join(' ');
          const statesInit = emitStatesSetup(node.states);
          const initCall = node.initMethod ? `this.init(${superArgs});` : '';
          const defaultEnterCall = (node.states && node.states.length > 0)
            ? `if (this.state === ${JSON.stringify(node.states[0].name)} && this._states[this.state] && typeof this._states[this.state].enter === 'function') this._states[this.state].enter();`
            : '';
          const timersInit = emitEntityTimersSetup(node.entityTimers);
          const methodsOut = [];
          const prevEnt = emitInEntityMethod;
          const prevTask = emitTaskDepth;
          emitInEntityMethod = true;
          if (node.initMethod) {
            emitTaskDepth = 0;
            methodsOut.push(`init(${emitParams(node.initMethod.params)}) ${emitBlock(node.initMethod.body)}`);
          }
          node.methods.forEach(m => {
            if (m.isTask) {
              emitTaskDepth = 1;
              const inner = emitBlock(m.body);
              emitTaskDepth = 0;
              methodsOut.push(`${m.name}(${emitParams(m.params)}) { const __royOwner = this; return __rt._runTask(__royOwner, async (__royTask) => ${inner}); }`);
            } else {
              emitTaskDepth = 0;
              const mAsync = astHasAwait(m.body);
              methodsOut.push(`${mAsync ? 'async ' : ''}${m.name}(${emitParams(m.params)}) ${emitBlock(m.body)}`);
            }
          });
          if (node.states && node.states.length > 0 && !node.superName) {
            methodsOut.push(`setState(nextName, ...args) { return __rt.setState(this, nextName, ...args); }`);
          }
          emitInEntityMethod = prevEnt;
          emitTaskDepth = prevTask;
          const extClause = node.superName ? ` extends ${node.superName}` : '';
          return `class ${node.name}${extClause} {\nconstructor(${ctorParamList}) {\n${superStmt}${assignParams}\n${fieldInits}\n${statesInit}\n${initCall}\n${defaultEnterCall}\n${timersInit}\n}\n${methodsOut.join('\n')}\n}`;
        }
        case 'EntityDecl': {
          const ctorParamList = emitParams(node.ctorParams);
          const superArgs = node.ctorParams.filter(p => p.name && !p.rest).map(p => p.name).join(', ');
          const baseName = node.superName || '__rt.BaseEntity';
          const superCall = node.superName ? `super(${superArgs}); this.tag = ${JSON.stringify(node.name)};` : `super(${JSON.stringify(node.name)});`;
          const assignParams = node.ctorParams.filter(p => p.name).map(p => `this[${JSON.stringify(p.name)}] = ${p.name};`).join(' ');
          const fieldInits = node.fields.map(f => `this[${JSON.stringify(f.name)}] = ${f.init ? emitExpr(f.init) : 'null'};`).join(' ');
          const statesInit = emitStatesSetup(node.states);
          const initCall = node.initMethod ? `this.init(${superArgs});` : '';
          const defaultEnterCall = (node.states && node.states.length > 0)
            ? `if (this.state === ${JSON.stringify(node.states[0].name)} && this._states[this.state] && typeof this._states[this.state].enter === 'function') this._states[this.state].enter();`
            : '';
          const timersInit = emitEntityTimersSetup(node.entityTimers);
          const methodsOut = [];
          const prevEnt = emitInEntityMethod;
          const prevTask = emitTaskDepth;
          emitInEntityMethod = true;
          if (node.initMethod) {
            emitTaskDepth = 0;
            methodsOut.push(`init(${emitParams(node.initMethod.params)}) ${emitBlock(node.initMethod.body)}`);
          }
          node.methods.forEach(m => {
            if (m.isTask) {
              emitTaskDepth = 1;
              const inner = emitBlock(m.body);
              emitTaskDepth = 0;
              methodsOut.push(`${m.name}(${emitParams(m.params)}) { const __royOwner = this; return __rt._runTask(__royOwner, async (__royTask) => ${inner}); }`);
            } else {
              emitTaskDepth = 0;
              const mAsync = astHasAwait(m.body);
              methodsOut.push(`${mAsync ? 'async ' : ''}${m.name}(${emitParams(m.params)}) ${emitBlock(m.body)}`);
            }
          });
          emitInEntityMethod = prevEnt;
          emitTaskDepth = prevTask;
          return `class ${node.name} extends ${baseName} {\nconstructor(${ctorParamList}) {\n${superCall}\n${assignParams}\n${fieldInits}\n${statesInit}\n${initCall}\n${defaultEnterCall}\n${timersInit}\n}\n${methodsOut.join('\n')}\n}`;
        }
        case 'OnHook': {
          const isAsync = astHasAwait(node.body);
          let normEv = node.event;
          if (normEv === 'drawui' || normEv === 'draw_ui') normEv = 'drawUi';
          const evKey = (normEv === 'enter' || normEv === 'exit' || normEv === 'resume') && node.sceneFilter
            ? `${normEv}:${node.sceneFilter}`
            : normEv;
          const regSceneCall = node.sceneFilter ? `__rt._regScene(${JSON.stringify(node.sceneFilter)}); ` : '';
          const filterGuard = (node.sceneFilter && normEv !== 'enter' && normEv !== 'exit' && normEv !== 'resume')
            ? `if (__rt.scene.name !== ${JSON.stringify(node.sceneFilter)}) return;\n`
            : '';
          const bodyJs = `{\n${filterGuard}${node.body.stmts.map(s => locTag(s) + emitStmt(s)).join('\n')}\n}`;
          return `${regSceneCall}__rt.on(${JSON.stringify(evKey)}, ${isAsync ? 'async ' : ''}function(${emitParams(node.params)}) ${bodyJs});`;
        }
        case 'AfterHook': {
          const isAsync = astHasAwait(node.body);
          if (emitInEntityMethod) {
            return `__rt.after(${emitExpr(node.msExpr)}, ${isAsync ? 'async ' : ''}() => ${emitBlock(node.body)}, this);`;
          }
          return `__rt.after(${emitExpr(node.msExpr)}, ${isAsync ? 'async ' : ''}function() ${emitBlock(node.body)});`;
        }
        case 'EveryHook': {
          const isAsync = astHasAwait(node.body);
          if (emitInEntityMethod) {
            return `__rt.every(${emitExpr(node.msExpr)}, ${isAsync ? 'async ' : ''}() => ${emitBlock(node.body)}, this);`;
          }
          return `__rt.every(${emitExpr(node.msExpr)}, ${isAsync ? 'async ' : ''}function() ${emitBlock(node.body)});`;
        }
        case 'If': {
          let out = `if (${emitExpr(node.cond)}) ${emitBlock(node.thenBlock)}`;
          if (node.elseBranch) {
            out += ' else ' + (node.elseBranch.type === 'If' ? emitStmt(node.elseBranch) : emitBlock(node.elseBranch));
          }
          return out;
        }
        case 'MatchStmt':
          return emitMatchBody(node, false);
        case 'While':
          return `while (${emitExpr(node.cond)}) { ${emitTaskDepth > 0 ? 'if (__rt._isTaskDead(__royTask)) return; ' : ''}if (++__rt._loopTicks > 1000000) __royLoopTick(); ${node.body.stmts.map(s => locTag(s) + emitStmt(s)).join('\n')} }`;
        case 'ForRange': {
          const eVar = nextTmp('end');
          const cmp = node.inclusive ? '<=' : '<';
          return `{ const ${eVar} = ${emitExpr(node.end)}; for (let ${node.varName} = ${emitExpr(node.start)}; ${node.varName} ${cmp} ${eVar}; ${node.varName}++) { ${emitTaskDepth > 0 ? 'if (__rt._isTaskDead(__royTask)) return; ' : ''}if (++__rt._loopTicks > 1000000) __royLoopTick(); ${node.body.stmts.map(s => locTag(s) + emitStmt(s)).join('\n')} } }`;
        }
        case 'ForEach': {
          const colVar = nextTmp('col');
          return `{ const ${colVar} = ${emitExpr(node.iterable)}; const __iterList = Array.isArray(${colVar}) ? ${colVar} : (${colVar} && typeof ${colVar} === 'object' ? Object.keys(${colVar}) : []); for (const ${node.varName} of __iterList) { ${emitTaskDepth > 0 ? 'if (__rt._isTaskDead(__royTask)) return; ' : ''}if (++__rt._loopTicks > 1000000) __royLoopTick(); ${node.body.stmts.map(s => locTag(s) + emitStmt(s)).join('\n')} } }`;
        }
        case 'ForEntries': {
          const colVar = nextTmp('col');
          return `{ const ${colVar} = ${emitExpr(node.iterable)}; const __iterEnt = Array.isArray(${colVar}) ? ${colVar}.map((__v, __i) => [__i, __v]) : (${colVar} && typeof ${colVar} === 'object' ? Object.entries(${colVar}) : []); for (const [${node.keyName}, ${node.valName}] of __iterEnt) { ${emitTaskDepth > 0 ? 'if (__rt._isTaskDead(__royTask)) return; ' : ''}if (++__rt._loopTicks > 1000000) __royLoopTick(); ${node.body.stmts.map(s => locTag(s) + emitStmt(s)).join('\n')} } }`;
        }
        case 'Repeat': {
          const cntVar = nextTmp('rep');
          const idxVar = nextTmp('i');
          return `{ const ${cntVar} = Math.max(0, Math.floor(${emitExpr(node.countExpr)})); for (let ${idxVar} = 0; ${idxVar} < ${cntVar}; ${idxVar}++) { ${emitTaskDepth > 0 ? 'if (__rt._isTaskDead(__royTask)) return; ' : ''}if (++__rt._loopTicks > 1000000) __royLoopTick(); ${node.body.stmts.map(s => locTag(s) + emitStmt(s)).join('\n')} } }`;
        }
        case 'DeleteStmt': return `delete ${emitExpr(node.target)};`;
        case 'Return':
          return node.value ? `return ${emitExpr(node.value)};` : 'return;';
        case 'Break': return 'break;';
        case 'Continue': return 'continue;';
        case 'ExprStmt': {
          if (emitTaskDepth > 0) {
            const waitCall = (node.expr && node.expr.type === 'Call' && node.expr.callee && node.expr.callee.type === 'Ident' && node.expr.callee.name === 'wait')
              ? node.expr
              : (node.expr && node.expr.type === 'Await' && node.expr.arg && node.expr.arg.type === 'Call' && node.expr.arg.callee && node.expr.arg.callee.type === 'Ident' && node.expr.arg.callee.name === 'wait' ? node.expr.arg : null);
            if (waitCall) {
              const argsStr = waitCall.args.map(a => emitExpr(a)).join(', ');
              return `{ await __rt._taskWait(__royTask${argsStr ? ', ' + argsStr : ''}); if (__rt._isTaskDead(__royTask)) return; }`;
            }
          }
          return `${emitExpr(node.expr)};`;
        }
        default:
          throw compileError('Неподдерживаемая инструкция: ' + node.type, node.line || 1, node.col || 1);
      }
    }

    const assetDeclPrefix = (assetManifest || []).map(a => `const ${a.alias} = __rt._assets[${JSON.stringify(a.alias)}];`).join('\n');
    const jsBody = (assetDeclPrefix ? assetDeclPrefix + '\n' : '') + ast.body.map(s => locTag(s) + emitStmt(s)).join('\n');
    return { jsCode: jsBody, meta, warnings };
  }

  function compile(source, projectFiles = null, entryPath = 'main.roy') {
    const src = String(source || '').replace(/^\uFEFF/, '');
    const filesMap = {};
    if (projectFiles && typeof projectFiles === 'object') {
      Object.keys(projectFiles).forEach(k => {
        const norm = normalizeRelPath(k);
        const raw = projectFiles[k];
        if (norm && raw !== undefined && raw !== null) {
          filesMap[norm] = typeof raw === 'string' ? { type: 'text', content: raw } : raw;
        }
      });
    }
    const entryNorm = normalizeRelPath(entryPath || 'main.roy') || 'main.roy';
    filesMap[entryNorm] = { type: 'text', content: src };

    const entryAst = parse(src, entryNorm);
    const visiting = new Set([entryNorm]);
    const importedSideEffects = new Set();
    const moduleCache = {};
    const hoistedModuleScopes = [];
    let modSeq = 0;
    const collectedAssets = [...(entryAst.assetBlocks || []).flatMap(ab => ab.entries)];

    function collectExportsFromBody(body) {
      const names = [];
      const localDeclared = new Set();
      (body || []).forEach(st => {
        if (!st) return;
        if (st.type === 'FnDecl' || st.type === 'TaskDecl' || st.type === 'EntityDecl' || st.type === 'ClassDecl' || st.type === 'EnumDecl') {
          if (st.name) localDeclared.add(st.name);
        } else if (st.type === 'VarDecl') {
          if (st.name) localDeclared.add(st.name);
          else if (st.pattern && st.pattern.type === 'ArrayPat') st.pattern.elements.forEach(e => localDeclared.add(e.name));
          else if (st.pattern && st.pattern.type === 'ObjectPat') st.pattern.props.forEach(p => localDeclared.add(p.alias));
        }
        if (st.exported) {
          if (st.type === 'FnDecl' || st.type === 'TaskDecl' || st.type === 'EntityDecl' || st.type === 'ClassDecl' || st.type === 'EnumDecl') {
            names.push(st.name);
          } else if (st.type === 'VarDecl') {
            if (st.name) names.push(st.name);
            else if (st.pattern && st.pattern.type === 'ArrayPat') st.pattern.elements.forEach(e => names.push(e.name));
            else if (st.pattern && st.pattern.type === 'ObjectPat') st.pattern.props.forEach(p => names.push(p.alias));
          }
        }
      });
      (body || []).forEach(st => {
        if (st && st.type === 'LocalExportList') {
          (st.specifiers || []).forEach(sp => {
            if (localDeclared.has(sp.name) && names.indexOf(sp.name) < 0) names.push(sp.name);
          });
        }
      });
      return names;
    }

    function ensureModuleCompiled(targetFile, st, currentFile) {
      if (moduleCache[targetFile]) return moduleCache[targetFile];
      visiting.add(targetFile);
      const mAst = parse(filesMap[targetFile].content, targetFile);
      (mAst.assetBlocks || []).forEach(ab => collectedAssets.push(...ab.entries));
      const reExports = [];
      const resolvedBody = resolveAstImports(mAst, targetFile, false, reExports);
      visiting.delete(targetFile);
      const ownExports = collectExportsFromBody(mAst.body);
      const allExportedNames = ownExports.slice();
      reExports.forEach(re => {
        if (allExportedNames.indexOf(re.exportName) < 0) allExportedNames.push(re.exportName);
      });
      const modVar = `__royMod_${++modSeq}`;
      moduleCache[targetFile] = { modVar, exportsList: allExportedNames };
      hoistedModuleScopes.push({
        type: 'ModuleScope',
        fileName: targetFile,
        modVar,
        body: resolvedBody,
        exportsList: ownExports,
        reExports,
        line: st.line,
        col: st.col
      });
      return moduleCache[targetFile];
    }

    function resolveAstImports(astNode, currentFile, isTopEntry, collectorReExports = null) {
      const outStmts = [];
      for (const st of astNode.body) {
        if (!st) continue;
        if (st.type === 'ReExportDecl') {
          const targetFile = resolveImportFile(currentFile, st.path, filesMap);
          if (!targetFile) {
            throw compileError(`Модуль "${st.path}" не найден в проекте`, st.line, st.col, currentFile);
          }
          if (visiting.has(targetFile)) {
            throw compileError(`Обнаружен циклический импорт модуля "${targetFile}"`, st.line, st.col, currentFile);
          }
          const cached = ensureModuleCompiled(targetFile, st, currentFile);
          if (st.mode === 'named') {
            st.specifiers.forEach(sp => {
              if (!cached.exportsList.includes(sp.name)) {
                throw compileError(`Модуль "${targetFile}" не экспортирует "${sp.name}" (для re-export)`, st.line, st.col, currentFile);
              }
              if (collectorReExports) {
                collectorReExports.push({ exportName: sp.alias, sourceModVar: cached.modVar, sourceName: sp.name });
              }
            });
          } else if (st.mode === 'all') {
            cached.exportsList.forEach(expName => {
              if (collectorReExports) {
                collectorReExports.push({ exportName: expName, sourceModVar: cached.modVar, sourceName: expName });
              }
            });
          }
          continue;
        }
        if (st.type !== 'ImportDecl') {
          outStmts.push(st);
          continue;
        }
        const targetFile = resolveImportFile(currentFile, st.path, filesMap);
        if (!targetFile) {
          throw compileError(`Модуль "${st.path}" не найден в проекте`, st.line, st.col, currentFile);
        }
        if (visiting.has(targetFile)) {
          throw compileError(`Обнаружен циклический импорт модуля "${targetFile}"`, st.line, st.col, currentFile);
        }

        if (st.mode === 'sideEffect') {
          if (!importedSideEffects.has(targetFile)) {
            importedSideEffects.add(targetFile);
            visiting.add(targetFile);
            const mAst = parse(filesMap[targetFile].content, targetFile);
            (mAst.assetBlocks || []).forEach(ab => collectedAssets.push(...ab.entries));
            const innerStmts = resolveAstImports(mAst, targetFile, false);
            visiting.delete(targetFile);
            outStmts.push(...innerStmts);
          }
        } else {
          const cached = ensureModuleCompiled(targetFile, st, currentFile);
          if (st.mode === 'named') {
            st.specifiers.forEach(sp => {
              if (!cached.exportsList.includes(sp.name)) {
                throw compileError(`Модуль "${targetFile}" не экспортирует "${sp.name}" (добавьте export перед объявлением)`, st.line, st.col, currentFile);
              }
            });
          }
          outStmts.push({
            type: 'ImportBinding',
            mode: st.mode,
            modVar: cached.modVar,
            nsAlias: st.nsAlias,
            specifiers: st.specifiers,
            line: st.line,
            col: st.col
          });
        }
      }
      return outStmts;
    }

    const entryResolvedStmts = resolveAstImports(entryAst, entryNorm, true);
    const mergedAst = {
      type: 'Program',
      fileName: entryNorm,
      gameHeader: entryAst.gameHeader,
      body: [...hoistedModuleScopes, ...entryResolvedStmts]
    };

    const assetMap = {};
    collectedAssets.forEach(a => { assetMap[a.alias] = a; });
    const uniqueAssets = Object.values(assetMap);

    const compiled = compileAst(mergedAst, uniqueAssets);
    try {
      new Function('__rt', 'RoySDK', '__royLoopTick', `return (async function(){\n${compiled.jsCode}\n});`);
    } catch (jsErr) {
      throw compileError('Внутренняя ошибка компиляции: ' + jsErr.message, 1, 1, entryNorm);
    }
    return {
      jsCode: compiled.jsCode,
      meta: compiled.meta,
      warnings: compiled.warnings || [],
      assets: uniqueAssets.map(a => ({ alias: a.alias, path: a.path })),
      lineCount: src.split('\n').length
    };
  }

  function compileToHtml(source, gameMeta, projectFiles = null, entryPath = 'main.roy', opts = null) {
    const compiled = compile(source, projectFiles, entryPath);
    const m = compiled.meta;
    const titleStr = (m && m.title) || (gameMeta && gameMeta.title) || 'RoyLang Game';
    const safeCode = compiled.jsCode.replace(/<\/script/gi, '<\\/script');
    const safeAssetsJson = JSON.stringify(compiled.assets || []).replace(/<\/script/gi, '<\\/script');
    const bgStr = String(m.bg || '#090d16');
    const w = Number(m.width) || 800;
    const h = Number(m.height) || 500;
    const pixelated = !!m.pixelated;
    const scaleMode = String(m.scaleMode || 'fit');
    const gamepadOpt = m.gamepad;
    const safeWarningsJson = JSON.stringify(compiled.warnings || []).replace(/<\/script/gi, '<\\/script');
    const startSceneOpt = (opts && opts.startScene) ? String(opts.startScene) : ((gameMeta && gameMeta.startScene) ? String(gameMeta.startScene) : 'main');

    return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>${_royEscapeHtml(titleStr)}</title>
  <style>
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: 100%; height: 100%; background: #050811; overflow: hidden; display: flex; align-items: center; justify-content: center; font-family: system-ui, -apple-system, sans-serif; color: #f8fafc; touch-action: none; user-select: none; }
#royCanvas {
  display: block;
  ${scaleMode === 'resize'
    ? 'width: 100vw; height: 100vh;'
    : `max-width: 100vw; max-height: 100vh; width: auto; height: auto; aspect-ratio: ${w} / ${h}; box-shadow: 0 14px 44px rgba(0,0,0,0.65); border-radius: 6px;`}
  background: ${bgStr};
  ${pixelated ? 'image-rendering: pixelated;' : ''}
}
  </style>
</head>
<body>
  <canvas id="royCanvas" width="${w}" height="${h}"></canvas>
  <script>
(function() {
  var canvas = document.getElementById('royCanvas');
  var rootCtx = canvas.getContext('2d');
  var worldCanvas = document.createElement('canvas');
  var worldCtx = worldCanvas.getContext('2d');
  var frameBaseCtx = worldCtx;
  var ctx = worldCtx;
  var SCALE_MODE = ${JSON.stringify(scaleMode)};
  var PIXELATED = ${pixelated ? 'true' : 'false'};
  var DPR = PIXELATED ? 1 : Math.min(2.5, Math.max(1, window.devicePixelRatio || 1));
  var W = ${w}, H = ${h}, BG = ${JSON.stringify(bgStr)};
  if (SCALE_MODE === 'resize') {
    W = Math.max(320, window.innerWidth || ${w});
    H = Math.max(240, window.innerHeight || ${h});
  }
  canvas.width = Math.round(W * DPR);
  canvas.height = Math.round(H * DPR);
  worldCanvas.width = canvas.width;
  worldCanvas.height = canvas.height;
  rootCtx.setTransform(DPR, 0, 0, DPR, 0, 0);
  worldCtx.setTransform(DPR, 0, 0, DPR, 0, 0);
  var ASSET_MANIFEST = ${safeAssetsJson};
  var COMPILE_WARNINGS = ${safeWarningsJson};
  var INITIAL_START_SCENE = ${JSON.stringify(startSceneOpt)};
  var GAME_LOCALE = ${JSON.stringify(m.locale || 'ru')};
  var hooks = { start: [], update: [], draw: [], drawUi: [], resize: [], keydown: [], keyup: [], click: [], pointermove: [], wheel: [] };
  var sceneHooks = {};
  var registeredScenes = ['main'];
  var timers = [];
  var afterTimers = [];
  var tweens = [];
  var worldEntities = [];
  var entitiesDrawnThisFrame = false;
  var keysDown = {};
  var keysJustPressed = {};
  var keysJustReleased = {};
  var virtualAxis = { x: 0, y: 0, active: false };
  var actionBindings = {};
  var hwPadState = { connected: false, id: '', lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0, btns: {}, prevBtns: {}, justPressed: {}, justReleased: {}, raw: null };
  var gestureState = {
    swipe: null, pinch: 0, pinchScale: 1, pinchCx: W / 2, pinchCy: H / 2, doubleTap: null,
    lastTapTime: 0, lastTapX: 0, lastTapY: 0,
    touchStartX: 0, touchStartY: 0, touchStartTime: 0, touchMoved: false, prevPinchDist: 0
  };
  var uiLayoutStack = [];
  var i18nState = { locale: (typeof GAME_LOCALE === 'string' && GAME_LOCALE) ? GAME_LOCALE : 'ru', dicts: { ru: {}, en: {} } };
  var activeAnims = [];
  var totalFrames = 0;
  var reverbState = { amount: 0, convolver: null, sendGain: null, wetGain: null };
  var bgmDuckGain = null;
  var flowFieldCache = {};
  var touches = [];
  var toastQueue = [];
  var queuedTooltips = [];
  var scrollStates = {};
  var uiScrollOffset = { x: 0, y: 0, stack: [] };
  var activeSliderId = null;
  var fontFamily = 'system-ui, -apple-system, sans-serif';
  var mouse = { x: W / 2, y: H / 2, rx: W / 2, ry: H / 2, wx: W / 2, wy: H / 2, dx: 0, dy: 0, down: false, clicked: false, justReleased: false, rightDown: false, rightClicked: false, middleDown: false, overUi: false, wheel: 0 };
  var cam = { x: 0, y: 0, zoom: 1, shakePow: 0, shakeDur: 0, shakeTime: 0, followTarget: null, followSmooth: 8, bounds: null };
  var frameCamTransform = { ox: 0, oy: 0, active: false };
  var freezeRem = 0;
  var gameplayTimeScale = 1;
  var flashState = { color: '#ffffff', rem: 0, dur: 0 };
  var transitionState = { active: false, kind: 'fade', color: '#000000', dur: 0.4, elapsed: 0, switched: false, target: 'main', payload: undefined };
  var currentScene = 'main';
  var sceneTime = 0;
  var sceneFrame = 0;
  var inDraw = false;
  var gameTime = 0;
  var currentFps = 60;
  var debugOverlay = false;
  var debugSceneRects = [];
  var debugGhostRects = [];
  var profStats = { update: 0, draw: 0, light: 0, postfx: 0, ui: 0, total: 16.6 };
  var f3GhostClip = null;
  var ghostRec = { active: false, target: null, rate: 30, acc: 0, t: 0, maxDur: 180, frames: [], sampler: null };
  var ghostPlayers = [];
  var activeNetSyncs = [];
  var dialogueState = {
    active: false, nodesMap: {}, order: [], curKey: '', speaker: '', fullText: '',
    shownChars: 0, speed: 48, color: '#38bdf8', portrait: null, choices: [], choiceRects: [],
    boxRect: null, chosenResult: null, resolve: null, opts: {}, drawnThisFrame: false, audioAcc: 0
  };
  var audioCtx = null;
  var masterComp = null;
  var noiseBuffer = null;
  var audioMuted = false;
  var tabMuted = false;
  var bgmState = { timer: null, tracks: [], drums: [], step: 0, nextTime: 0, stepSec: 0.125, vol: 0.055, key: '', bus: null, masterGain: null, sections: null, lastCfg: null };
  var runtimeErrorBanner = '';
  var lastLoopTicks = 0;
  var telemetryTimer = 0;
  var sceneStack = [];
  var activeTasks = [];
  var taskWaiters = [];
  var shockwaves = [];

  if (${JSON.stringify(gamepadOpt)} !== null) {
    try { window.parent.postMessage({ type: 'roy-gamepad-config', visible: !!${JSON.stringify(gamepadOpt)} }, '*'); } catch(e) {}
  }

  function applyResizeMode() {
    DPR = PIXELATED ? 1 : Math.min(2.5, Math.max(1, window.devicePixelRatio || 1));
    if (SCALE_MODE === 'resize') {
      W = Math.max(320, window.innerWidth || W);
      H = Math.max(240, window.innerHeight || H);
    }
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    worldCanvas.width = canvas.width;
    worldCanvas.height = canvas.height;
    rootCtx.setTransform(DPR, 0, 0, DPR, 0, 0);
    worldCtx.setTransform(DPR, 0, 0, DPR, 0, 0);
    if (SCALE_MODE === 'resize') {
      hooks.resize.forEach(function(fn) { __rt._loopTicks = 0; Promise.resolve(fn(W, H)).catch(handleHookError); });
    }
  }
  window.addEventListener('resize', applyResizeMode);

  function __royLoopTick() {
    if (__rt._loopTicks > 1000000) throw new Error('Превышен лимит итераций цикла за кадр (1 000 000)');
  }

  function emitConsole(level, text) {
    try {
      window.parent.postMessage({ type: 'roystudio-console', level: level, text: String(text) }, '*');
    } catch(e) {}
  }

  COMPILE_WARNINGS.forEach(function(w) { emitConsole('warn', w); });

  function formatRoyError(err) {
    var msg = String(err && err.message ? err.message : err || 'Неизвестная ошибка');
    var locPrefix = __rt && __rt._loc ? ('[' + __rt._loc + '] ') : '';
    var mRead = /Cannot read propert(?:y|ies) of (?:undefined|null) \\(reading '([^']+)'\\)/.exec(msg);
    if (mRead) return locPrefix + 'Попытка прочитать поле "' + mRead[1] + '" у пустого значения (null)';
    var mSet = /Cannot set propert(?:y|ies) of (?:undefined|null) \\(setting '([^']+)'\\)/.exec(msg);
    if (mSet) return locPrefix + 'Попытка записать поле "' + mSet[1] + '" в пустое значение (null)';
    var mUndef = /^([a-zA-Z_$][a-zA-Z0-9_$]*) is not defined$/.exec(msg);
    if (mUndef) return locPrefix + 'Переменная или функция "' + mUndef[1] + '" не объявлена';
    var mNotFn = /^([\\s\\S]+) is not a function$/.exec(msg);
    if (mNotFn) return locPrefix + '"' + mNotFn[1] + '" не является функцией (возможно, опечатка или лишние скобки)';
    if (msg.indexOf('Assignment to constant variable') >= 0) return locPrefix + 'Нельзя перезаписать константу (const)';
    return locPrefix + msg;
  }

  function handleHookError(err) {
    var pretty = formatRoyError(err);
    if (runtimeErrorBanner !== pretty) {
      runtimeErrorBanner = pretty;
      emitConsole('error', pretty);
    }
  }

  var NOTE_SEMITONES = { C: 0, 'C#': 1, DB: 1, D: 2, 'D#': 3, EB: 3, E: 4, F: 5, 'F#': 6, GB: 6, G: 7, 'G#': 8, AB: 8, A: 9, 'A#': 10, BB: 10, B: 11 };
  function noteToFreq(note) {
    if (typeof note === 'number') return note;
    var m = /^([a-gA-G][#bB]?)(-?[0-9])$/.exec(String(note || '').trim());
    if (!m) return 440;
    var semi = NOTE_SEMITONES[m[1].toUpperCase()];
    if (semi === undefined) return 440;
    var midi = (Number(m[2]) + 1) * 12 + semi;
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  document.addEventListener('visibilitychange', function() {
    tabMuted = !!document.hidden;
    if (audioCtx) {
      if ((audioMuted || tabMuted) && audioCtx.state === 'running') audioCtx.suspend().catch(function(){});
      else if (!audioMuted && !tabMuted && audioCtx.state === 'suspended') audioCtx.resume().catch(function(){});
    }
  });
  function unlockAudioCtx() {
    if (!audioMuted && !tabMuted && audioCtx && (audioCtx.state === 'suspended' || audioCtx.state === 'interrupted')) {
      audioCtx.resume().catch(function(){});
    }
  }
  document.addEventListener('touchend', unlockAudioCtx, { passive: true });
  document.addEventListener('pointerdown', unlockAudioCtx, { passive: true });
  document.addEventListener('keydown', unlockAudioCtx, { passive: true });

  function setMuted(flag) {
    audioMuted = !!flag;
    if (audioCtx) {
      if (audioMuted && audioCtx.state === 'running') audioCtx.suspend().catch(function(){});
      else if (!audioMuted && !tabMuted && audioCtx.state === 'suspended') audioCtx.resume().catch(function(){});
    }
    return audioMuted;
  }

  function ensureAudioMaster() {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    if (!audioCtx) audioCtx = new Ctx();
    if (!masterComp && audioCtx) {
      try {
        masterComp = audioCtx.createDynamicsCompressor();
        masterComp.threshold.setValueAtTime(-16, audioCtx.currentTime);
        masterComp.knee.setValueAtTime(18, audioCtx.currentTime);
        masterComp.ratio.setValueAtTime(6, audioCtx.currentTime);
        masterComp.attack.setValueAtTime(0.005, audioCtx.currentTime);
        masterComp.release.setValueAtTime(0.18, audioCtx.currentTime);
        masterComp.connect(audioCtx.destination);
      } catch(e) {
        masterComp = audioCtx.destination;
      }
    }
    if (!noiseBuffer && audioCtx) {
      try {
        var sr = audioCtx.sampleRate || 44100;
        var buf = audioCtx.createBuffer(1, Math.floor(sr * 0.5), sr);
        var ch = buf.getChannelData(0);
        for (var i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
        noiseBuffer = buf;
      } catch(e) {}
    }
    if (!bgmDuckGain && audioCtx && masterComp) {
      try {
        bgmDuckGain = audioCtx.createGain();
        bgmDuckGain.gain.setValueAtTime(1, audioCtx.currentTime);
        bgmDuckGain.connect(masterComp);
      } catch(e) { bgmDuckGain = null; }
    }
    return masterComp || (audioCtx && audioCtx.destination) || null;
  }

  function ensureReverbBus(durSec) {
    var dest = ensureAudioMaster();
    if (!audioCtx || !dest) return null;
    if (!reverbState.convolver && audioCtx.createConvolver) {
      try {
        var sr = audioCtx.sampleRate || 44100;
        var len = Math.max(256, Math.floor(sr * Math.max(0.15, Math.min(1.5, Number(durSec) || 0.36))));
        var ir = audioCtx.createBuffer(2, len, sr);
        for (var c = 0; c < 2; c++) {
          var ch = ir.getChannelData(c);
          for (var i = 0; i < len; i++) {
            var env = Math.pow(1 - i / len, 2.6);
            ch[i] = (Math.random() * 2 - 1) * env * 0.55;
          }
        }
        var conv = audioCtx.createConvolver();
        conv.buffer = ir;
        var sendG = audioCtx.createGain();
        var wetG = audioCtx.createGain();
        sendG.gain.setValueAtTime(1, audioCtx.currentTime);
        wetG.gain.setValueAtTime(reverbState.amount * 0.55, audioCtx.currentTime);
        sendG.connect(conv);
        conv.connect(wetG);
        wetG.connect(dest);
        reverbState.convolver = conv;
        reverbState.sendGain = sendG;
        reverbState.wetGain = wetG;
      } catch(e) {}
    }
    return reverbState.sendGain;
  }

  function setReverb(amount, durSec) {
    reverbState.amount = Math.max(0, Math.min(1, Number(amount) || 0));
    if (reverbState.amount > 0) {
      ensureReverbBus(durSec);
    }
    if (reverbState.wetGain && audioCtx) {
      try {
        reverbState.wetGain.gain.setTargetAtTime(reverbState.amount * 0.55, audioCtx.currentTime, 0.02);
      } catch(e) {}
    }
    return reverbState.amount;
  }

  function duckBgm(depth, recoverSec) {
    if (!bgmDuckGain || !audioCtx) return;
    try {
      var t = audioCtx.currentTime;
      var d = Math.max(0.15, Math.min(0.92, depth === undefined ? 0.45 : Number(depth)));
      var rec = Math.max(0.06, Math.min(0.8, recoverSec === undefined ? 0.2 : Number(recoverSec)));
      bgmDuckGain.gain.cancelScheduledValues(t);
      bgmDuckGain.gain.setValueAtTime(Math.max(0.15, bgmDuckGain.gain.value || 1), t);
      bgmDuckGain.gain.linearRampToValueAtTime(d, t + 0.02);
      bgmDuckGain.gain.linearRampToValueAtTime(1, t + 0.02 + rec);
    } catch(e) {}
  }

  function calcSpatialAudio(opts) {
    if (!opts || typeof opts !== 'object') return { gain: 1, pan: 0, audible: true };
    var panVal = opts.pan !== undefined ? Math.max(-1, Math.min(1, Number(opts.pan) || 0)) : 0;
    var gainMul = 1;
    if (opts.x !== undefined || opts.y !== undefined) {
      var lx = cam.x + W * 0.5, ly = cam.y + H * 0.5;
      var sx = opts.x !== undefined ? Number(opts.x) : lx;
      var sy = opts.y !== undefined ? Number(opts.y) : ly;
      var dx = sx - lx, dy = sy - ly;
      var maxD = Math.max(80, Number(opts.maxDist) || Math.max(W, H) * 0.85);
      var d = Math.hypot(dx, dy);
      if (d >= maxD) return { gain: 0, pan: 0, audible: false };
      gainMul = Math.max(0.02, 1 - d / maxD);
      if (opts.pan === undefined) panVal = Math.max(-1, Math.min(1, dx / Math.max(120, W * 0.55)));
    }
    return { gain: gainMul, pan: panVal, audible: gainMul > 0.015 };
  }

  function routeAudioOutput(node, dest, panVal) {
    var outNode = node;
    if (panVal && Math.abs(panVal) > 0.01 && audioCtx && audioCtx.createStereoPanner) {
      var panner = audioCtx.createStereoPanner();
      panner.pan.setValueAtTime(Math.max(-1, Math.min(1, panVal)), audioCtx.currentTime);
      node.connect(panner);
      panner.connect(dest);
      outNode = panner;
    } else {
      node.connect(dest);
    }
    if (reverbState.amount > 0.01) {
      var revSend = ensureReverbBus();
      if (revSend) { try { outNode.connect(revSend); } catch(e) {} }
    }
  }

  function tone(freq, durMsOrSec, wave, vol, slideToFreq, panVal) {
    if (audioMuted || tabMuted) return;
    try {
      var dest = ensureAudioMaster();
      if (!audioCtx || !dest) return;
      if (audioCtx.state === 'suspended' || audioCtx.state === 'interrupted') audioCtx.resume().catch(function(){});
      var f = noteToFreq(freq);
      var rawD = Number(durMsOrSec) || 0.12;
      var dur = Math.max(0.02, rawD > 5 ? rawD / 1000 : rawD);
      var volume = Math.max(0.002, Math.min(0.6, vol === undefined ? 0.08 : Number(vol)));
      var nowT = audioCtx.currentTime;
      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      osc.type = wave || 'square';
      osc.frequency.setValueAtTime(Math.max(20, f), nowT);
      if (slideToFreq !== undefined && slideToFreq !== null) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(20, noteToFreq(slideToFreq)), nowT + dur);
      }
      gain.gain.setValueAtTime(volume, nowT);
      gain.gain.exponentialRampToValueAtTime(0.001, nowT + dur);
      osc.connect(gain);
      routeAudioOutput(gain, dest, panVal || 0);
      osc.start(nowT);
      osc.stop(nowT + dur);
    } catch(e) {}
  }

  function synth(opts) {
    if (audioMuted || tabMuted) return;
    var o = (opts && typeof opts === 'object') ? opts : {};
    var sp = calcSpatialAudio(o);
    if (!sp.audible) return;
    try {
      var dest = ensureAudioMaster();
      if (!audioCtx || !dest) return;
      if (audioCtx.state === 'suspended' || audioCtx.state === 'interrupted') audioCtx.resume().catch(function(){});
      var nowT = audioCtx.currentTime;
      var rawD = o.dur !== undefined ? Number(o.dur) : (o.duration !== undefined ? Number(o.duration) : 0.18);
      var dur = Math.max(0.02, rawD > 5 ? rawD / 1000 : rawD);
      var att = Math.max(0.002, Math.min(dur * 0.5, Number(o.attack !== undefined ? o.attack : 0.008)));
      var dec = Math.max(0.005, Math.min(dur * 0.6, Number(o.decay !== undefined ? o.decay : dur * 0.3)));
      var sus = Math.max(0.01, Math.min(1, Number(o.sustain !== undefined ? o.sustain : 0.35)));
      var peak = Math.max(0.003, Math.min(0.65, (o.vol !== undefined ? Number(o.vol) : 0.1) * sp.gain));
      var outGain = audioCtx.createGain();
      outGain.gain.setValueAtTime(0.0005, nowT);
      outGain.gain.linearRampToValueAtTime(peak, nowT + att);
      outGain.gain.exponentialRampToValueAtTime(Math.max(0.001, peak * sus), nowT + Math.min(dur * 0.85, att + dec));
      outGain.gain.exponentialRampToValueAtTime(0.0005, nowT + dur);

      var filterNode = null;
      if (o.filter || o.cutoff) {
        filterNode = audioCtx.createBiquadFilter();
        filterNode.type = o.filterType || 'lowpass';
        filterNode.frequency.setValueAtTime(Math.max(60, Math.min(18000, Number(o.filter || o.cutoff) || 1800)), nowT);
        if (o.q !== undefined) filterNode.Q.setValueAtTime(Math.max(0.1, Math.min(20, Number(o.q) || 1)), nowT);
        filterNode.connect(outGain);
      }
      var targetNode = filterNode || outGain;
      routeAudioOutput(outGain, dest, sp.pan);

      var noiseMix = Math.max(0, Math.min(1, Number(o.noise) || 0));
      if (o.duck || (noiseMix >= 0.35 && peak >= 0.06)) duckBgm(0.52, 0.18);
      if (noiseMix < 0.99) {
        var osc = audioCtx.createOscillator();
        var oscGain = audioCtx.createGain();
        osc.type = o.wave || 'sawtooth';
        var jitAmt = o.jitter !== undefined ? Math.max(0, Math.min(0.4, Number(o.jitter) || 0)) : 0;
      var jitMul = jitAmt > 0 ? (1 + (Math.random() * 2 - 1) * jitAmt) : 1;
      var f0 = Math.max(20, noteToFreq(o.freq !== undefined ? o.freq : 260) * jitMul);
        osc.frequency.setValueAtTime(f0, nowT);
        var fEnd = o.freqEnd !== undefined ? o.freqEnd : o.slide;
        if (fEnd !== undefined && fEnd !== null) {
          osc.frequency.exponentialRampToValueAtTime(Math.max(20, noteToFreq(fEnd)), nowT + dur);
        }
        oscGain.gain.setValueAtTime(1 - noiseMix * 0.65, nowT);
        osc.connect(oscGain); oscGain.connect(targetNode);
        osc.start(nowT); osc.stop(nowT + dur + 0.01);
      }
      if (noiseMix > 0 && noiseBuffer) {
        var nSrc = audioCtx.createBufferSource();
        var nGain = audioCtx.createGain();
        nSrc.buffer = noiseBuffer;
        nGain.gain.setValueAtTime(noiseMix, nowT);
        nSrc.connect(nGain); nGain.connect(targetNode);
        nSrc.start(nowT); nSrc.stop(nowT + dur + 0.01);
      }
    } catch(e) {}
  }

  function melody(notes, stepMs, wave, vol, pitchMul, panVal) {
    if (!Array.isArray(notes)) return;
    var step = Number(stepMs) || 140;
    var pm = pitchMul || 1;
    notes.forEach(function(n, idx) {
      if (!n || n === '-' || n === '_') return;
      setTimeout(function() { tone(noteToFreq(n) * pm, Math.max(0.05, (step * 0.85) / 1000), wave || 'triangle', vol, null, panVal); }, idx * step);
    });
  }

  function sfx(name, opts) {
    var o = (opts && typeof opts === 'object') ? opts : {};
    var sp = calcSpatialAudio(o);
    if (!sp.audible) return;
    var vMul = (o.vol !== undefined ? Number(o.vol) : 1) * sp.gain;
    var jit = o.jitter !== undefined ? Math.max(0, Math.min(0.35, Number(o.jitter) || 0)) : (o.pitch === undefined ? 0.06 : 0);
    var pBase = o.pitch !== undefined ? Math.max(0.25, Math.min(4, Number(o.pitch) || 1)) : 1;
    var pMul = pBase * (jit > 0 ? (1 + (Math.random() * 2 - 1) * jit) : 1);
    var pan = sp.pan;
    var bv = 0.08 * vMul;
    var n = String(name || '').toLowerCase();
    if (n === 'coin') { tone(987 * pMul, 0.08, 'sine', bv, null, pan); setTimeout(function(){ tone(1318 * pMul, 0.12, 'sine', bv, null, pan); }, 55); }
    else if (n === 'jump') { tone(320 * pMul, 0.09, 'triangle', bv, 520 * pMul, pan); }
    else if (n === 'hit' || n === 'hurt') { duckBgm(0.62, 0.14); tone(140 * pMul, 0.16, 'sawtooth', bv * 1.1, 70 * pMul, pan); }
    else if (n === 'laser' || n === 'shoot') { tone(880 * pMul, 0.09, 'sawtooth', bv, 320 * pMul, pan); }
    else if (n === 'explosion' || n === 'boom') { duckBgm(0.45, 0.22); synth({ wave: 'sawtooth', freq: 95 * pMul, freqEnd: 32, dur: 0.32, noise: 0.65, filter: 900, vol: bv * 1.35, pan: pan }); }
    else if (n === 'powerup') { melody(['C5','E5','G5','C6'], 65, 'triangle', bv, pMul, pan); }
    else if (n === 'win') { melody(['C5','E5','G5','C6'], 90, 'sine', bv, pMul, pan); }
    else { tone(620 * pMul, 0.05, 'sine', bv, null, pan); }
  }

  function parseBgmNotes(seq) {
    if (Array.isArray(seq)) return seq.slice();
    return String(seq || '').trim().split(/\\s+/);
  }

  function expandChordNotes(tok) {
    var s = String(tok || '').trim();
    if (!s || s === '-' || s === '_' || s === '.') return [];
    if (s.indexOf('+') >= 0) {
      return s.split('+').map(function(p) { return noteToFreq(p.trim()); });
    }
    var cm = /^([a-gA-G][#bB]?)(m|min|dim|maj7|m7|7)(-?[0-9])$/.exec(s);
    if (cm) {
      var root = noteToFreq(cm[1] + cm[3]);
      var q = cm[2].toLowerCase();
      var semis = q === 'dim' ? [0, 3, 6] : (q === 'm' || q === 'min') ? [0, 3, 7] : (q === 'm7') ? [0, 3, 7, 10] : (q === 'maj7') ? [0, 4, 7, 11] : [0, 4, 7, 10];
      return semis.map(function(st) { return root * Math.pow(2, st / 12); });
    }
    return [noteToFreq(s)];
  }

  function scheduleBgmStep(noteStr, atTime, durSec, wave, vol, outNode) {
    var freqs = expandChordNotes(noteStr);
    if (!freqs.length || !audioCtx || audioMuted || tabMuted) return;
    var perVol = Math.max(0.002, vol / Math.max(1, Math.sqrt(freqs.length)));
    try {
      for (var i = 0; i < freqs.length; i++) {
        var osc = audioCtx.createOscillator();
        var gain = audioCtx.createGain();
        osc.type = wave || 'triangle';
        osc.frequency.setValueAtTime(Math.max(25, freqs[i]), atTime);
        gain.gain.setValueAtTime(perVol, atTime);
        gain.gain.exponentialRampToValueAtTime(0.0008, atTime + Math.max(0.04, durSec * 0.92));
        osc.connect(gain);
        gain.connect(outNode || masterComp || audioCtx.destination);
        osc.start(atTime);
        osc.stop(atTime + durSec);
      }
    } catch(e) {}
  }

  function scheduleDrumStep(tok, atTime, vol, outNode) {
    if (!tok || tok === '.' || tok === '-' || tok === '_') return;
    if (!audioCtx || audioMuted || tabMuted) return;
    var code = String(tok).toUpperCase();
    var dest = outNode || masterComp || audioCtx.destination;
    var v = Math.max(0.01, Math.min(0.45, vol * 2.2));
    try {
      if (code === 'K') {
        var kOsc = audioCtx.createOscillator();
        var kGain = audioCtx.createGain();
        kOsc.type = 'sine';
        kOsc.frequency.setValueAtTime(145, atTime);
        kOsc.frequency.exponentialRampToValueAtTime(42, atTime + 0.13);
        kGain.gain.setValueAtTime(v, atTime);
        kGain.gain.exponentialRampToValueAtTime(0.001, atTime + 0.14);
        kOsc.connect(kGain); kGain.connect(dest);
        kOsc.start(atTime); kOsc.stop(atTime + 0.15);
      } else if (code === 'S') {
        if (noiseBuffer) {
          var sSrc = audioCtx.createBufferSource();
          sSrc.buffer = noiseBuffer;
          var sHp = audioCtx.createBiquadFilter();
          sHp.type = 'highpass'; sHp.frequency.setValueAtTime(950, atTime);
          var sGain = audioCtx.createGain();
          sGain.gain.setValueAtTime(v * 0.65, atTime);
          sGain.gain.exponentialRampToValueAtTime(0.001, atTime + 0.13);
          sSrc.connect(sHp); sHp.connect(sGain); sGain.connect(dest);
          sSrc.start(atTime); sSrc.stop(atTime + 0.14);
        }
        var bOsc = audioCtx.createOscillator();
        var bGain = audioCtx.createGain();
        bOsc.type = 'triangle';
        bOsc.frequency.setValueAtTime(195, atTime);
        bOsc.frequency.exponentialRampToValueAtTime(95, atTime + 0.08);
        bGain.gain.setValueAtTime(v * 0.5, atTime);
        bGain.gain.exponentialRampToValueAtTime(0.001, atTime + 0.09);
        bOsc.connect(bGain); bGain.connect(dest);
        bOsc.start(atTime); bOsc.stop(atTime + 0.1);
      } else if ((code === 'H' || code === 'O') && noiseBuffer) {
        var hSrc = audioCtx.createBufferSource();
        hSrc.buffer = noiseBuffer;
        var hHp = audioCtx.createBiquadFilter();
        hHp.type = 'highpass'; hHp.frequency.setValueAtTime(code === 'O' ? 5800 : 7200, atTime);
        var hGain = audioCtx.createGain();
        var hDur = code === 'O' ? 0.15 : 0.045;
        hGain.gain.setValueAtTime(v * 0.38, atTime);
        hGain.gain.exponentialRampToValueAtTime(0.001, atTime + hDur);
        hSrc.connect(hHp); hHp.connect(hGain); hGain.connect(dest);
        hSrc.start(atTime); hSrc.stop(atTime + hDur + 0.01);
      }
    } catch(e) {}
  }

  function stopBgm() {
    if (bgmState.timer) { clearInterval(bgmState.timer); bgmState.timer = null; }
    if (bgmState.masterGain) { try { bgmState.masterGain.disconnect(); } catch(e) {} bgmState.masterGain = null; }
    if (bgmState.bus) { try { bgmState.bus.disconnect(); } catch(e) {} bgmState.bus = null; }
    bgmState.tracks = [];
    bgmState.drums = [];
    bgmState.key = '';
  }

  function bgm(patterns, bpm, wave, vol, opts, fadeInSec) {
    var activePatterns = patterns;
    if (patterns && typeof patterns === 'object' && !Array.isArray(patterns) && patterns.sections) {
      bgmState.sections = patterns.sections;
      var secKey = patterns.current || Object.keys(patterns.sections)[0];
      activePatterns = patterns.sections[secKey] || {};
      if (!bpm && activePatterns.bpm) bpm = activePatterns.bpm;
    }
    var cfg = (opts && typeof opts === 'object') ? opts : ((activePatterns && typeof activePatterns === 'object' && !Array.isArray(activePatterns)) ? activePatterns : {});
    var sig = JSON.stringify([activePatterns, bpm, wave, vol, opts]);
    if (bgmState.timer && bgmState.key === sig && !fadeInSec) return;
    stopBgm();
    bgmState.lastCfg = { patterns: activePatterns, bpm: bpm, wave: wave, vol: vol, opts: opts };
    var trackList = [];
    var drumList = [];
    var baseVol = vol === undefined ? 0.05 : Math.max(0.005, Math.min(0.4, Number(vol)));
    if (Array.isArray(activePatterns) || typeof activePatterns === 'string') {
      trackList.push({ notes: parseBgmNotes(activePatterns), wave: wave || 'triangle', vol: baseVol });
    } else if (activePatterns && typeof activePatterns === 'object') {
      if (activePatterns.lead) trackList.push({ notes: parseBgmNotes(activePatterns.lead), wave: wave || 'square', vol: baseVol });
      if (activePatterns.chords) trackList.push({ notes: parseBgmNotes(activePatterns.chords), wave: 'triangle', vol: baseVol * 0.72 });
      if (activePatterns.bass) trackList.push({ notes: parseBgmNotes(activePatterns.bass), wave: 'sawtooth', vol: baseVol * 0.85 });
      if (activePatterns.arp) trackList.push({ notes: parseBgmNotes(activePatterns.arp), wave: 'triangle', vol: baseVol * 0.65 });
      if (activePatterns.drums) drumList = parseBgmNotes(activePatterns.drums);
    }
    if (!trackList.length && !drumList.length) return;
    var tempo = Math.max(40, Math.min(300, Number(bpm || (activePatterns && activePatterns.bpm)) || 120));
    bgmState.stepSec = 60 / tempo / 2;
    bgmState.tracks = trackList;
    bgmState.drums = drumList;
    bgmState.step = 0;
    bgmState.key = sig;
    var dest = ensureAudioMaster();
    if (audioCtx && dest) {
      var busIn = audioCtx.createGain();
      var masterFade = audioCtx.createGain();
      if (fadeInSec && fadeInSec > 0) {
        masterFade.gain.setValueAtTime(0.0001, audioCtx.currentTime);
        masterFade.gain.linearRampToValueAtTime(1, audioCtx.currentTime + fadeInSec);
      } else {
        masterFade.gain.setValueAtTime(1, audioCtx.currentTime);
      }
      var chainTail = busIn;
      if (cfg.lowpass || cfg.cutoff) {
        var lp = audioCtx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.setValueAtTime(Math.max(120, Math.min(18000, Number(cfg.lowpass || cfg.cutoff) || 2400)), audioCtx.currentTime);
        chainTail.connect(lp);
        chainTail = lp;
      }
      if (cfg.reverb !== undefined) setReverb(cfg.reverb);
      chainTail.connect(masterFade);
      masterFade.connect(bgmDuckGain || dest);
      if (reverbState.amount > 0.01) {
        var revBgm = ensureReverbBus();
        if (revBgm) { try { masterFade.connect(revBgm); } catch(e) {} }
      }
      var echoAmt = Number(cfg.delay !== undefined ? cfg.delay : cfg.echo) || 0;
      if (echoAmt > 0 && audioCtx.createDelay) {
        var dly = audioCtx.createDelay(1.0);
        dly.delayTime.setValueAtTime(Math.min(0.6, bgmState.stepSec * 1.5), audioCtx.currentTime);
        var fb = audioCtx.createGain();
        fb.gain.setValueAtTime(Math.min(0.55, echoAmt * 0.45), audioCtx.currentTime);
        var wet = audioCtx.createGain();
        wet.gain.setValueAtTime(Math.min(0.6, echoAmt * 0.5), audioCtx.currentTime);
        chainTail.connect(dly);
        dly.connect(fb); fb.connect(dly);
        dly.connect(wet); wet.connect(masterFade);
      }
      bgmState.bus = busIn;
      bgmState.masterGain = masterFade;
    }
    bgmState.nextTime = audioCtx ? audioCtx.currentTime + 0.05 : 0;
    bgmState.timer = setInterval(function() {
      if (!audioCtx) return;
      if (audioMuted || tabMuted || audioCtx.state !== 'running') {
        bgmState.nextTime = audioCtx.currentTime + 0.05;
        return;
      }
      var lookAhead = audioCtx.currentTime + 0.14;
      while (bgmState.nextTime < lookAhead) {
        for (var ti = 0; ti < bgmState.tracks.length; ti++) {
          var tr = bgmState.tracks[ti];
          if (tr.notes.length > 0) {
            scheduleBgmStep(tr.notes[bgmState.step % tr.notes.length], bgmState.nextTime, bgmState.stepSec, tr.wave, tr.vol, bgmState.bus);
          }
        }
        if (bgmState.drums.length > 0) {
          scheduleDrumStep(bgmState.drums[bgmState.step % bgmState.drums.length], bgmState.nextTime, baseVol, bgmState.bus);
        }
        bgmState.nextTime += bgmState.stepSec;
        bgmState.step++;
      }
    }, 35);
  }

  function syncBgm(patternsOrSection, opts) {
    var o = (opts && typeof opts === 'object') ? opts : {};
    var rawF = o.fade !== undefined ? Number(o.fade) : 0.6;
    var fadeSec = Math.max(0.05, rawF > 10 ? rawF / 1000 : rawF);
    var nextPat = patternsOrSection;
    if (typeof patternsOrSection === 'string' && bgmState.sections && bgmState.sections[patternsOrSection]) {
      nextPat = bgmState.sections[patternsOrSection];
    }
    var prevTimer = bgmState.timer;
    var prevMaster = bgmState.masterGain;
    var prevBus = bgmState.bus;
    var prevStep = bgmState.step;
    bgmState.timer = null;
    bgmState.masterGain = null;
    bgmState.bus = null;
    if (prevTimer) clearInterval(prevTimer);
    if (prevMaster && audioCtx) {
      try {
        prevMaster.gain.cancelScheduledValues(audioCtx.currentTime);
        prevMaster.gain.setValueAtTime(prevMaster.gain.value || 1, audioCtx.currentTime);
        prevMaster.gain.linearRampToValueAtTime(0.0001, audioCtx.currentTime + fadeSec);
        setTimeout(function() {
          try { prevMaster.disconnect(); if (prevBus) prevBus.disconnect(); } catch(e) {}
        }, Math.round(fadeSec * 1000) + 80);
      } catch(e) {}
    }
    var lc = bgmState.lastCfg || {};
    bgm(
      nextPat,
      o.bpm !== undefined ? o.bpm : (nextPat && nextPat.bpm ? nextPat.bpm : lc.bpm),
      o.wave !== undefined ? o.wave : lc.wave,
      o.vol !== undefined ? o.vol : lc.vol,
      o.opts || opts || lc.opts,
      fadeSec
    );
    if (o.keepPhase) bgmState.step = prevStep;
  }

  function loadImageAsset(path, onDone) {
    var img = new Image();
    var pStr = String(path || '');
    if (pStr.indexOf('data:') !== 0 && pStr.indexOf('blob:') !== 0) {
      img.crossOrigin = 'anonymous';
    }
    var wrap = {
      path: path, ready: false, width: 0, height: 0, img: img,
      draw: function(px, py, rot, scaleMul, flipX) {
        if (!wrap.ready) return;
        var sm = (scaleMul === undefined || scaleMul === null) ? 1 : Number(scaleMul);
        var cw = wrap.width, ch = wrap.height;
        ctx.save();
        ctx.translate((px || 0) + (cw * sm) / 2, (py || 0) + (ch * sm) / 2);
        if (rot) ctx.rotate(rot);
        ctx.scale(flipX ? -sm : sm, sm);
        ctx.drawImage(img, -cw / 2, -ch / 2);
        ctx.restore();
      },
      drawScaled: function(px, py, dw, dh, rot, flipX) {
        if (!wrap.ready) return;
        var w0 = Number(dw) || wrap.width, h0 = Number(dh) || wrap.height;
        ctx.save();
        ctx.translate((px || 0) + w0 / 2, (py || 0) + h0 / 2);
        if (rot) ctx.rotate(rot);
        if (flipX) ctx.scale(-1, 1);
        ctx.drawImage(img, -w0 / 2, -h0 / 2, w0, h0);
        ctx.restore();
      },
      drawFrame: function(col, row, fw, fh, px, py, rot, scaleMul, flipX) {
        if (!wrap.ready) return;
        var cellW = Number(fw) || 32, cellH = Number(fh) || 32;
        var sm = (scaleMul === undefined || scaleMul === null) ? 1 : Number(scaleMul);
        ctx.save();
        ctx.translate((px || 0) + (cellW * sm) / 2, (py || 0) + (cellH * sm) / 2);
        if (rot) ctx.rotate(rot);
        ctx.scale(flipX ? -sm : sm, sm);
        ctx.drawImage(img, (Number(col) || 0) * cellW, (Number(row) || 0) * cellH, cellW, cellH, -cellW / 2, -cellH / 2, cellW, cellH);
        ctx.restore();
      }
    };
    img.onload = function() {
      wrap.ready = true;
      wrap.width = img.naturalWidth || img.width || 0;
      wrap.height = img.naturalHeight || img.height || 0;
      if (onDone) onDone(wrap);
    };
    img.onerror = function() {
      emitConsole('error', 'Не удалось загрузить картинку: ' + path);
      if (onDone) onDone(wrap);
    };
    img.src = pStr;
    return wrap;
  }

  function loadSoundAsset(path, onDone) {
    var base = new Audio();
    var activeLoops = [];
    var finished = false;
    function doneOnce() { if (!finished) { finished = true; wrap.ready = true; if (onDone) onDone(wrap); } }
    var wrap = {
      path: path, ready: false, audio: base,
      play: function(vol, rate) {
        try {
          var inst = base.cloneNode();
          inst.volume = Math.max(0, Math.min(1, vol === undefined ? 0.85 : Number(vol)));
          if (rate) inst.playbackRate = Number(rate) || 1;
          inst.play().catch(function(){});
          return inst;
        } catch(e) { return null; }
      },
      loop: function(vol) {
        try {
          var inst = base.cloneNode();
          inst.loop = true;
          inst.volume = Math.max(0, Math.min(1, vol === undefined ? 0.6 : Number(vol)));
          inst.play().catch(function(){});
          activeLoops.push(inst);
          return inst;
        } catch(e) { return null; }
      },
      stop: function() {
        try { base.pause(); base.currentTime = 0; } catch(e) {}
        activeLoops.forEach(function(a) { try { a.pause(); a.currentTime = 0; } catch(e) {} });
        activeLoops = [];
      }
    };
    base.oncanplaythrough = doneOnce;
    base.onerror = function() { emitConsole('error', 'Не удалось загрузить звук: ' + path); doneOnce(); };
    base.src = String(path || '');
    setTimeout(doneOnce, 1200);
    return wrap;
  }

  function loadJsonAsset(path) {
    return fetch(String(path || '')).then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function preloadManifestAssets(list) {
    if (!Array.isArray(list) || list.length === 0) return Promise.resolve({});
    var loaded = 0, total = list.length;
    var outMap = {};
    function drawLoadProgress() {
      ctx.fillStyle = BG || '#090d16';
      ctx.fillRect(0, 0, W, H);
      var bw = Math.min(340, W * 0.65), bh = 14, bx = (W - bw) / 2, by = H / 2 - 7;
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(bx, by, bw, bh);
      ctx.fillStyle = '#38bdf8';
      ctx.fillRect(bx, by, bw * (loaded / Math.max(1, total)), bh);
      ctx.fillStyle = '#e2e8f0';
      ctx.font = '700 14px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Загрузка ассетов: ' + loaded + ' / ' + total, W / 2, by - 14);
      ctx.textAlign = 'left';
    }
    drawLoadProgress();
    return Promise.all(list.map(function(item) {
      var p = String(item.path || '');
      var ext = p.split('.').pop().toLowerCase();
      if (['mp3', 'wav', 'ogg', 'm4a', 'flac'].indexOf(ext) >= 0) {
        return new Promise(function(res) {
          outMap[item.alias] = loadSoundAsset(p, function() { loaded++; drawLoadProgress(); res(); });
        });
      }
      if (ext === 'json') {
        var jsonHolder = { path: p, ready: false, data: null };
        outMap[item.alias] = jsonHolder;
        return loadJsonAsset(p).then(function(d) {
          jsonHolder.data = d; jsonHolder.ready = true;
        }).catch(function(err) {
          emitConsole('error', 'Ошибка JSON (' + p + '): ' + err.message);
        }).then(function() { loaded++; drawLoadProgress(); });
      }
      return new Promise(function(res) {
        outMap[item.alias] = loadImageAsset(p, function() { loaded++; drawLoadProgress(); res(); });
      });
    })).then(function() { return outMap; });
  }

  function tilemap(rows, palette, tileSize) {
    var ts = Math.max(4, Number(tileSize) || 32);
    var grid = (Array.isArray(rows) ? rows : String(rows || '').split('\\n')).map(function(r) {
      return Array.isArray(r) ? r.slice() : String(r).split('');
    });
    var pal = palette || { '#': '#334155', '=': '#64748b', 'W': '#3b82f6' };
    var maxCols = 0;
    for (var r = 0; r < grid.length; r++) { if (grid[r].length > maxCols) maxCols = grid[r].length; }
    function isSolidChar(ch) {
      if (!ch || ch === ' ' || ch === '.') return false;
      var entry = pal[ch];
      if (entry && typeof entry === 'object' && entry.solid === false) return false;
      return true;
    }
    return {
      _isTilemap: true,
      _rows: grid,
      _isSolidChar: isSolidChar,
      tileSize: ts,
      rows: grid.length,
      cols: maxCols,
      get: function(tx, ty) {
        if (ty < 0 || ty >= grid.length || tx < 0 || tx >= grid[ty].length) return '';
        return grid[ty][tx];
      },
      set: function(tx, ty, ch) {
        if (ty >= 0 && ty < grid.length && tx >= 0) grid[ty][tx] = String(ch || '.')[0] || '.';
      },
      solidAt: function(px, py) {
        var tx = Math.floor(px / ts), ty = Math.floor(py / ts);
        if (ty < 0 || ty >= grid.length || tx < 0 || tx >= grid[ty].length) return false;
        return isSolidChar(grid[ty][tx]);
      },
      collidesRect: function(rx, ry, rw, rh) {
        var x0 = Math.floor(rx / ts), y0 = Math.floor(ry / ts);
        var x1 = Math.floor((rx + Math.max(0.01, rw - 0.01)) / ts);
        var y1 = Math.floor((ry + Math.max(0.01, rh - 0.01)) / ts);
        for (var gy = y0; gy <= y1; gy++) {
          if (gy < 0 || gy >= grid.length) continue;
          for (var gx = x0; gx <= x1; gx++) {
            if (gx < 0 || gx >= grid[gy].length) continue;
            if (isSolidChar(grid[gy][gx])) return true;
          }
        }
        return false;
      },
      draw: function(ox, oy) {
        var dx = Number(ox) || 0, dy = Number(oy) || 0;
        for (var gy = 0; gy < grid.length; gy++) {
          var rowArr = grid[gy];
          for (var gx = 0; gx < rowArr.length; gx++) {
            var ch = rowArr[gx];
            if (!ch || ch === ' ' || ch === '.') continue;
            var val = pal[ch];
            if (!val) continue;
            var px = dx + gx * ts, py = dy + gy * ts;
            if (typeof val === 'string') {
              ctx.fillStyle = val;
              ctx.fillRect(px, py, ts, ts);
            } else if (val && val.drawScaled) {
              val.drawScaled(px, py, ts, ts);
            } else if (val && val.canvas) {
              ctx.drawImage(val.canvas, px, py, ts, ts);
            } else if (val && val.color) {
              ctx.fillStyle = val.color;
              ctx.fillRect(px, py, ts, ts);
            }
          }
        }
      }
    };
  }

  function tileMask(gridSrc, gx, gy, wallSpec, oobSolid) {
    var rows = gridSrc && gridSrc._rows ? gridSrc._rows : gridSrc;
    if (!Array.isArray(rows) || !rows.length) return 0;
    var gh = rows.length;
    function isMatch(cx, cy) {
      if (cy < 0 || cy >= gh) return !!oobSolid;
      var row = rows[cy];
      var gw = Array.isArray(row) ? row.length : String(row || '').length;
      if (cx < 0 || cx >= gw) return !!oobSolid;
      var v = Array.isArray(row) ? row[cx] : String(row)[cx];
      if (typeof wallSpec === 'function') return !!wallSpec(v, cx, cy);
      if (wallSpec === undefined) {
        if (gridSrc && gridSrc._isTilemap && typeof gridSrc._isSolidChar === 'function') return gridSrc._isSolidChar(v);
        return v === '#' || v === 1 || v === true;
      }
      if (typeof wallSpec === 'string') return wallSpec.indexOf(String(v)) >= 0;
      return v === wallSpec;
    }
    var ix = Math.floor(gx), iy = Math.floor(gy);
    return (isMatch(ix, iy - 1) ? 1 : 0) | (isMatch(ix + 1, iy) ? 2 : 0) | (isMatch(ix, iy + 1) ? 4 : 0) | (isMatch(ix - 1, iy) ? 8 : 0);
  }

  function collides(a, b) {
    if (!a || !b) return false;
    if (b._isTilemap) {
      var ax0 = a._shape === 'circle' ? a.x - a.r : a.x;
      var ay0 = a._shape === 'circle' ? a.y - a.r : a.y;
      var aw0 = a._shape === 'circle' ? a.r * 2 : (a.w || 0);
      var ah0 = a._shape === 'circle' ? a.r * 2 : (a.h || 0);
      return b.collidesRect(ax0, ay0, aw0, ah0);
    }
    if (a._isTilemap) return collides(b, a);
    if (a._shape === 'circle' && b._shape === 'circle') {
      var dx = a.x - b.x, dy = a.y - b.y, rr = (a.r || 0) + (b.r || 0);
      return dx * dx + dy * dy <= rr * rr;
    }
    var ax = a._shape === 'circle' ? a.x - a.r : a.x;
    var ay = a._shape === 'circle' ? a.y - a.r : a.y;
    var aw = a._shape === 'circle' ? a.r * 2 : (a.w || 0);
    var ah = a._shape === 'circle' ? a.r * 2 : (a.h || 0);
    var bx = b._shape === 'circle' ? b.x - b.r : b.x;
    var by = b._shape === 'circle' ? b.y - b.r : b.y;
    var bw = b._shape === 'circle' ? b.r * 2 : (b.w || 0);
    var bh = b._shape === 'circle' ? b.r * 2 : (b.h || 0);
    return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
  }

  function moveAndCollide(ent, dx, dy, obstacles) {
    if (!ent) return { hitX: false, hitY: false };
    var list = !obstacles ? [] : (Array.isArray(obstacles) ? obstacles : [obstacles]);
    var isCirc = ent._shape === 'circle';
    var rw = isCirc ? (ent.r || 16) * 2 : (ent.w || 32);
    var rh = isCirc ? (ent.r || 16) * 2 : (ent.h || 32);
    function boxHit(nx, ny) {
      for (var i = 0; i < list.length; i++) {
        var ob = list[i];
        if (!ob || ob === ent || ob.alive === false) continue;
        if (ob._isTilemap) {
          if (ob.collidesRect(nx, ny, rw, rh)) return true;
        } else {
          var bx = ob._shape === 'circle' ? ob.x - ob.r : ob.x;
          var by = ob._shape === 'circle' ? ob.y - ob.r : ob.y;
          var bw = ob._shape === 'circle' ? ob.r * 2 : (ob.w || 0);
          var bh = ob._shape === 'circle' ? ob.r * 2 : (ob.h || 0);
          if (nx < bx + bw && nx + rw > bx && ny < by + bh && ny + rh > by) return true;
        }
      }
      return false;
    }
    var hitX = false, hitY = false;
    var oldX = ent.x;
    ent.x += Number(dx) || 0;
    var bx0 = isCirc ? ent.x - ent.r : ent.x;
    var by0 = isCirc ? ent.y - ent.r : ent.y;
    if (boxHit(bx0, by0)) {
      ent.x = oldX;
      hitX = true;
    }
    var oldY = ent.y;
    ent.y += Number(dy) || 0;
    var bx1 = isCirc ? ent.x - ent.r : ent.x;
    var by1 = isCirc ? ent.y - ent.r : ent.y;
    if (boxHit(bx1, by1)) {
      ent.y = oldY;
      hitY = true;
      if ((Number(dy) || 0) > 0) ent.grounded = true;
    } else if ((Number(dy) || 0) !== 0) {
      ent.grounded = false;
    }
    return { hitX: hitX, hitY: hitY };
  }

  function raycast(x1, y1, x2, y2, obstacles) {
    var list = !obstacles ? [] : (Array.isArray(obstacles) ? obstacles : [obstacles]);
    var dx = x2 - x1, dy = y2 - y1;
    var totalDist = Math.hypot(dx, dy);
    if (totalDist < 0.0001) return { hit: false, x: x2, y: y2, dist: 0, target: null };
    var steps = Math.max(2, Math.ceil(totalDist / 4));
    var sx = dx / steps, sy = dy / steps;
    for (var s = 1; s <= steps; s++) {
      var px = x1 + sx * s, py = y1 + sy * s;
      for (var i = 0; i < list.length; i++) {
        var ob = list[i];
        if (!ob || ob.alive === false) continue;
        if (ob._isTilemap) {
          if (ob.solidAt(px, py)) return { hit: true, x: px, y: py, dist: Math.hypot(px - x1, py - y1), target: ob };
        } else {
          var bx = ob._shape === 'circle' ? ob.x - ob.r : ob.x;
          var by = ob._shape === 'circle' ? ob.y - ob.r : ob.y;
          var bw = ob._shape === 'circle' ? ob.r * 2 : (ob.w || 0);
          var bh = ob._shape === 'circle' ? ob.r * 2 : (ob.h || 0);
          if (px >= bx && px <= bx + bw && py >= by && py <= by + bh) {
            return { hit: true, x: px, y: py, dist: Math.hypot(px - x1, py - y1), target: ob };
          }
        }
      }
    }
    return { hit: false, x: x2, y: y2, dist: totalDist, target: null };
  }

  function lineOfSight(x1, y1, x2, y2, obstacles, wallSpec) {
    var list = !obstacles ? [] : (Array.isArray(obstacles) ? obstacles : [obstacles]);
    if (wallSpec === undefined) return !raycast(x1, y1, x2, y2, list).hit;
    var dx = x2 - x1, dy = y2 - y1;
    var totalDist = Math.hypot(dx, dy);
    if (totalDist < 0.0001) return true;
    var steps = Math.max(2, Math.ceil(totalDist / 4));
    var sx = dx / steps, sy = dy / steps;
    for (var s = 1; s < steps; s++) {
      var px = x1 + sx * s, py = y1 + sy * s;
      for (var i = 0; i < list.length; i++) {
        var ob = list[i];
        if (!ob || ob.alive === false) continue;
        if (ob._isTilemap) {
          var ch = ob.get(Math.floor(px / ob.tileSize), Math.floor(py / ob.tileSize));
          var hitCh = typeof wallSpec === 'function' ? !!wallSpec(ch) : (typeof wallSpec === 'string' ? wallSpec.indexOf(String(ch)) >= 0 : ch === wallSpec);
          if (hitCh) return false;
        } else {
          var bx = ob._shape === 'circle' ? ob.x - ob.r : ob.x;
          var by = ob._shape === 'circle' ? ob.y - ob.r : ob.y;
          var bw = ob._shape === 'circle' ? ob.r * 2 : (ob.w || 0);
          var bh = ob._shape === 'circle' ? ob.r * 2 : (ob.h || 0);
          if (px >= bx && px <= bx + bw && py >= by && py <= by + bh) return false;
        }
      }
    }
    return true;
  }

  function moveCircle(ent, dx, dy, obstacles, radiusOverride) {
    if (!ent) return { hit: false, nx: 0, ny: 0 };
    var rad = Number(radiusOverride || ent.r || (ent.w ? ent.w * 0.5 : 16)) || 16;
    var list = !obstacles ? [] : (Array.isArray(obstacles) ? obstacles : [obstacles]);
    ent.x += Number(dx) || 0;
    ent.y += Number(dy) || 0;
    var hit = false, lnx = 0, lny = 0;
    function pushBox(bx, by, bw, bh) {
      var cx = Math.max(bx, Math.min(bx + bw, ent.x));
      var cy = Math.max(by, Math.min(by + bh, ent.y));
      var ddx = ent.x - cx, ddy = ent.y - cy;
      var d2 = ddx * ddx + ddy * ddy;
      if (d2 >= rad * rad) return;
      hit = true;
      var nx = 0, ny = 0, pen = 0;
      if (d2 > 0.00001) {
        var d = Math.sqrt(d2);
        nx = ddx / d; ny = ddy / d; pen = rad - d;
      } else {
        var dl = Math.abs(ent.x - bx), dr = Math.abs(bx + bw - ent.x);
        var dt = Math.abs(ent.y - by), db = Math.abs(by + bh - ent.y);
        var m = Math.min(dl, dr, dt, db);
        if (m === dl) { nx = -1; pen = rad + dl; }
        else if (m === dr) { nx = 1; pen = rad + dr; }
        else if (m === dt) { ny = -1; pen = rad + dt; }
        else { ny = 1; pen = rad + db; }
      }
      ent.x += nx * pen;
      ent.y += ny * pen;
      lnx = nx; lny = ny;
    }
    for (var i = 0; i < list.length; i++) {
      var ob = list[i];
      if (!ob || ob === ent || ob.alive === false) continue;
      if (ob._isTilemap) {
        var ts = ob.tileSize;
        var x0 = Math.floor((ent.x - rad) / ts), y0 = Math.floor((ent.y - rad) / ts);
        var x1 = Math.floor((ent.x + rad) / ts), y1 = Math.floor((ent.y + rad) / ts);
        for (var gy = y0; gy <= y1; gy++) {
          if (gy < 0 || gy >= ob.rows) continue;
          for (var gx = x0; gx <= x1; gx++) {
            if (gx < 0 || gx >= ob.cols) continue;
            if (ob._isSolidChar(ob.get(gx, gy))) pushBox(gx * ts, gy * ts, ts, ts);
          }
        }
      } else if (ob._shape === 'circle') {
        var r2 = Number(ob.r) || 16;
        var cdx = ent.x - ob.x, cdy = ent.y - ob.y;
        var d2 = cdx * cdx + cdy * cdy, minR = rad + r2;
        if (d2 < minR * minR) {
          hit = true;
          var d = Math.sqrt(d2) || 0.001;
          var nx = cdx / d, ny = cdy / d;
          ent.x += nx * (minR - d);
          ent.y += ny * (minR - d);
          lnx = nx; lny = ny;
        }
      } else {
        pushBox(Number(ob.x) || 0, Number(ob.y) || 0, Number(ob.w) || 0, Number(ob.h) || 0);
      }
    }
    return { hit: hit, nx: lnx, ny: lny };
  }

  function isOptsObj(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function drawRect(x, y, w, h, color, radius) {
    var col = color, rad = radius, strokeC = null, lw = 2;
    if (isOptsObj(color)) {
      col = color.color !== undefined ? color.color : (color.fill !== undefined ? color.fill : '#38bdf8');
      rad = color.radius !== undefined ? color.radius : color.r;
      strokeC = color.stroke || color.strokeColor || null;
      lw = color.lw || color.lineWidth || 2;
    }
    if (col !== null) {
      ctx.fillStyle = col || '#38bdf8';
      if (rad && rad > 0 && ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, rad);
        ctx.fill();
      } else {
        ctx.fillRect(x, y, w, h);
      }
    }
    if (strokeC) {
      ctx.strokeStyle = strokeC;
      ctx.lineWidth = lw;
      if (rad && rad > 0 && ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, rad);
        ctx.stroke();
      } else {
        ctx.strokeRect(x, y, w, h);
      }
    }
  }

  function drawGradient(x, y, w, h, c1, c2, vertical) {
    var vert = vertical === undefined ? true : !!vertical;
    var grad = vert ? ctx.createLinearGradient(x, y, x, y + h) : ctx.createLinearGradient(x, y, x + w, y);
    grad.addColorStop(0, c1 || '#0f172a');
    grad.addColorStop(1, c2 || '#1e293b');
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, w, h);
  }

  function isUiClipSafe(rawX, rawY) {
    for (var ci = 0; ci < uiScrollOffset.stack.length; ci++) {
      var s = uiScrollOffset.stack[ci];
      if (rawX < s.bx || rawX > s.bx + s.bw || rawY < s.by || rawY > s.by + s.bh) return false;
    }
    return true;
  }

  function hovered(x, y, w, h) {
    if (!isUiClipSafe(mouse.x, mouse.y)) return false;
    var mx = mouse.x - uiScrollOffset.x, my = mouse.y - uiScrollOffset.y;
    return mx >= x && mx <= x + w && my >= y && my <= y + h;
  }

  function uiConsumeSlot(w, h) {
    if (uiLayoutStack.length === 0) return null;
    var box = uiLayoutStack[uiLayoutStack.length - 1];
    var bw = w !== undefined && w !== null ? Number(w) : (box.kind === 'vbox' ? Math.max(40, box.w - box.pad * 2) : 140);
    var bh = h !== undefined && h !== null ? Number(h) : 40;
    var rx = box.curX, ry = box.curY;
    if (box.kind === 'vbox') {
      box.curY += bh + box.gap;
      box.contentH = Math.max(box.contentH, box.curY - box.y);
    } else {
      box.curX += bw + box.gap;
      box.contentW = Math.max(box.contentW, box.curX - box.x);
    }
    return { x: rx, y: ry, w: bw, h: bh };
  }

  function vbox(x, y, w, hOrOpts, optsOrFn, fnOpt) {
    var o = isOptsObj(hOrOpts) ? hOrOpts : (isOptsObj(optsOrFn) ? optsOrFn : {});
    var fn = typeof hOrOpts === 'function' ? hOrOpts : (typeof optsOrFn === 'function' ? optsOrFn : (typeof fnOpt === 'function' ? fnOpt : null));
    var bw = Number(o.w || o.width || w) || 260;
    var bh = !isOptsObj(hOrOpts) && typeof hOrOpts === 'number' ? hOrOpts : (Number(o.h || o.height) || 320);
    var pad = o.pad !== undefined ? Number(o.pad) : (o.padding !== undefined ? Number(o.padding) : 0);
    var gap = o.gap !== undefined ? Number(o.gap) : 8;
    if (o.bg || o.panel || o.border) {
      panel(x, y, bw, bh, o);
    }
    uiLayoutStack.push({ kind: 'vbox', x: x, y: y, w: bw, h: bh, curX: x + pad, curY: y + pad, gap: gap, pad: pad, contentH: pad, contentW: bw });
    if (fn) { try { fn(); } finally { layoutEnd(); } }
  }

  function hbox(x, y, w, hOrOpts, optsOrFn, fnOpt) {
    var o = isOptsObj(hOrOpts) ? hOrOpts : (isOptsObj(optsOrFn) ? optsOrFn : {});
    var fn = typeof hOrOpts === 'function' ? hOrOpts : (typeof optsOrFn === 'function' ? optsOrFn : (typeof fnOpt === 'function' ? fnOpt : null));
    var bw = Number(o.w || o.width || w) || 400;
    var bh = !isOptsObj(hOrOpts) && typeof hOrOpts === 'number' ? hOrOpts : (Number(o.h || o.height) || 64);
    var pad = o.pad !== undefined ? Number(o.pad) : (o.padding !== undefined ? Number(o.padding) : 0);
    var gap = o.gap !== undefined ? Number(o.gap) : 8;
    if (o.bg || o.panel || o.border) {
      panel(x, y, bw, bh, o);
    }
    uiLayoutStack.push({ kind: 'hbox', x: x, y: y, w: bw, h: bh, curX: x + pad, curY: y + pad, gap: gap, pad: pad, contentH: bh, contentW: pad });
    if (fn) { try { fn(); } finally { layoutEnd(); } }
  }

  function layoutEnd() {
    if (uiLayoutStack.length > 0) return uiLayoutStack.pop();
    return null;
  }

  var scrollViewMaxCache = {};
  function scrollView(id, w, h, contentHOrFn, fnOpt) {
    var key = String(id || 'scroll_view');
    var fn = typeof contentHOrFn === 'function' ? contentHOrFn : (typeof fnOpt === 'function' ? fnOpt : null);
    var slot = uiConsumeSlot(w, h) || { x: 0, y: 0, w: Number(w) || 260, h: Number(h) || 240 };
    var estH = typeof contentHOrFn === 'number' ? contentHOrFn : (scrollViewMaxCache[key] || slot.h);
    scrollBegin(key, slot.x, slot.y, slot.w, slot.h, estH);
    uiLayoutStack.push({ kind: 'vbox', x: slot.x, y: slot.y, w: slot.w - 10, h: slot.h, curX: slot.x + 4, curY: slot.y + 4, gap: 8, pad: 4, contentH: 4, contentW: slot.w - 10 });
    if (fn) {
      try { fn(); } finally {
        var finished = layoutEnd();
        if (finished) scrollViewMaxCache[key] = Math.max(slot.h, finished.contentH + 8);
        scrollEnd();
      }
    }
  }

  function uiButton(label, opts) {
    var o = isOptsObj(opts) ? opts : {};
    var slot = uiConsumeSlot(o.w || o.width || null, o.h || o.height || 42) || { x: Number(o.x) || 0, y: Number(o.y) || 0, w: Number(o.w) || 180, h: Number(o.h) || 42 };
    return button(label, slot.x, slot.y, slot.w, slot.h, o);
  }

  function uiLabel(str, opts) {
    var o = isOptsObj(opts) ? opts : {};
    var sz = Number(o.size) || 15;
    var lh = Number(o.h || o.height) || Math.round(sz * 1.45);
    var slot = uiConsumeSlot(o.w || o.width || null, lh) || { x: Number(o.x) || 0, y: Number(o.y) || 0, w: Number(o.w) || 200, h: lh };
    var al = o.align || 'left';
    var tx = al === 'center' ? slot.x + slot.w * 0.5 : (al === 'right' ? slot.x + slot.w : slot.x);
    text(String(str ?? ''), tx, slot.y + 2, o.color || '#e2e8f0', sz, al);
  }

  function uiPanel(w, h, opts) {
    var o = isOptsObj(opts) ? opts : {};
    var slot = uiConsumeSlot(w, h) || { x: Number(o.x) || 0, y: Number(o.y) || 0, w: Number(w) || 200, h: Number(h) || 120 };
    panel(slot.x, slot.y, slot.w, slot.h, o);
    return slot;
  }

  function setLocale(loc) {
    var s = String(loc || 'ru').trim().toLowerCase();
    if (s) i18nState.locale = s;
    return i18nState.locale;
  }
  function getLocale() { return i18nState.locale; }
  function addTranslations(mapOrLoc, entries) {
    if (typeof mapOrLoc === 'string' && isOptsObj(entries)) {
      var lc = mapOrLoc.trim().toLowerCase();
      if (!i18nState.dicts[lc]) i18nState.dicts[lc] = {};
      Object.keys(entries).forEach(function(k) { i18nState.dicts[lc][k] = entries[k]; });
      return;
    }
    if (isOptsObj(mapOrLoc)) {
      Object.keys(mapOrLoc).forEach(function(langKey) {
        var tbl = mapOrLoc[langKey];
        if (isOptsObj(tbl)) {
          var lNorm = String(langKey).trim().toLowerCase();
          if (!i18nState.dicts[lNorm]) i18nState.dicts[lNorm] = {};
          Object.keys(tbl).forEach(function(k) { i18nState.dicts[lNorm][k] = tbl[k]; });
        }
      });
    }
  }
  function t(key, vars) {
    var k = String(key || '');
    var dCur = i18nState.dicts[i18nState.locale] || {};
    var dEn = i18nState.dicts['en'] || {};
    var dRu = i18nState.dicts['ru'] || {};
    var raw = dCur[k] !== undefined ? dCur[k] : (dEn[k] !== undefined ? dEn[k] : (dRu[k] !== undefined ? dRu[k] : k));
    var out = String(raw);
    if (isOptsObj(vars)) {
      out = out.replace(/\$\{([a-zA-Z0-9_]+)\}|\{([a-zA-Z0-9_]+)\}/g, function(m, a, b) {
        var name = a || b;
        return vars[name] !== undefined ? String(vars[name]) : m;
      });
    }
    return out;
  }

  function button(label, x, y, w, h, col, hoverCol, textCol, radius) {
    var o = null;
    if (isOptsObj(w)) { o = w; }
    else if (isOptsObj(col)) { o = col; }
    var bw = Number(o && (o.w || o.width) !== undefined ? (o.w || o.width) : w) || 160;
    var bh = Number(o && (o.h || o.height) !== undefined ? (o.h || o.height) : h) || 44;
    var bx = x, by = y;
    if ((bx === null || bx === undefined || bx === 'auto') && uiLayoutStack.length > 0) {
      var sl = uiConsumeSlot(bw, bh);
      bx = sl.x; by = sl.y; bw = sl.w; bh = sl.h;
    }
    var fillC = o ? (o.color || o.col || o.bg) : col;
    var hovC = o ? (o.hoverCol || o.hover) : hoverCol;
    var txtC = o ? (o.textCol || o.textColor) : textCol;
    var bdrC = o ? (o.borderCol || o.border) : null;
    var rad = o && (o.radius !== undefined || o.r !== undefined) ? (o.radius !== undefined ? o.radius : o.r) : (radius === undefined ? 8 : radius);
    var mx = mouse.x - uiScrollOffset.x, my = mouse.y - uiScrollOffset.y;
    var hov = isUiClipSafe(mouse.x, mouse.y) && mx >= bx && mx <= bx + bw && my >= by && my <= by + bh;
    x = bx; y = by;
    if (hov) mouse.overUi = true;
    drawRect(x, y, bw, bh, hov ? (hovC || '#2563eb') : (fillC || '#1e293b'), rad);
    ctx.strokeStyle = bdrC || (hov ? '#93c5fd' : 'rgba(148,163,184,0.35)');
    ctx.lineWidth = hov ? 2 : 1;
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, bw, bh, rad); ctx.stroke(); }
    else { ctx.strokeRect(x, y, bw, bh); }
    ctx.fillStyle = txtC || '#f8fafc';
    var fSz = (o && o.fontSize) ? Number(o.fontSize) : Math.max(12, Math.min(20, Math.floor(bh * 0.42)));
    ctx.font = '800 ' + fSz + 'px ' + fontFamily;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(label || ''), x + bw / 2, y + bh / 2);
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    return hov && mouse.clicked;
  }

  function panel(x, y, w, h, bgCol, borderCol, radius, lw) {
    var o = isOptsObj(bgCol) ? bgCol : null;
    var bg = o ? (o.bgCol !== undefined ? o.bgCol : (o.bg !== undefined ? o.bg : o.color)) : bgCol;
    var brd = o ? (o.borderCol !== undefined ? o.borderCol : o.border) : borderCol;
    var rad = o && (o.radius !== undefined || o.r !== undefined) ? (o.radius !== undefined ? o.radius : o.r) : (radius === undefined ? 10 : radius);
    var lineW = o ? (o.lw || o.lineWidth || 1.5) : (lw || 1.5);
    drawRect(x, y, w, h, bg || 'rgba(15,23,42,0.88)', rad);
    if (brd !== null) {
      ctx.strokeStyle = brd || 'rgba(148,163,184,0.35)';
      ctx.lineWidth = lineW;
      if (ctx.roundRect && rad > 0) { ctx.beginPath(); ctx.roundRect(x, y, w, h, rad); ctx.stroke(); }
      else { ctx.strokeRect(x, y, w, h); }
    }
    var mx = mouse.x - uiScrollOffset.x, my = mouse.y - uiScrollOffset.y;
    if (mx >= x && mx <= x + w && my >= y && my <= y + h) mouse.overUi = true;
  }

  function panel9(imgOrSprite, x, y, w, h, borderPx) {
    var src = imgOrSprite && (imgOrSprite.img || imgOrSprite.canvas || imgOrSprite);
    var ready = imgOrSprite && imgOrSprite.img ? !!imgOrSprite.ready : (src && (src.naturalWidth || src.width) > 0);
    var dw = Math.max(2, Number(w) || 64), dh = Math.max(2, Number(h) || 64);
    var b = Math.max(1, Number(borderPx) || 8);
    if (!ready) { panel(x, y, dw, dh); return; }
    var sw = imgOrSprite.width || src.naturalWidth || src.width;
    var sh = imgOrSprite.height || src.naturalHeight || src.height;
    var bx = Math.min(b, Math.floor(sw * 0.45), Math.floor(dw * 0.45));
    var by = Math.min(b, Math.floor(sh * 0.45), Math.floor(dh * 0.45));
    var mcw = Math.max(0, sw - bx * 2), mch = Math.max(0, sh - by * 2);
    var dmw = Math.max(0, dw - bx * 2), dmh = Math.max(0, dh - by * 2);
    ctx.drawImage(src, 0, 0, bx, by, x, y, bx, by);
    if (dmw > 0 && mcw > 0) ctx.drawImage(src, bx, 0, mcw, by, x + bx, y, dmw, by);
    ctx.drawImage(src, sw - bx, 0, bx, by, x + dw - bx, y, bx, by);
    if (dmh > 0 && mch > 0) {
      ctx.drawImage(src, 0, by, bx, mch, x, y + by, bx, dmh);
      if (dmw > 0 && mcw > 0) ctx.drawImage(src, bx, by, mcw, mch, x + bx, y + by, dmw, dmh);
      ctx.drawImage(src, sw - bx, by, bx, mch, x + dw - bx, y + by, bx, dmh);
    }
    ctx.drawImage(src, 0, sh - by, bx, by, x, y + dh - by, bx, by);
    if (dmw > 0 && mcw > 0) ctx.drawImage(src, bx, sh - by, mcw, by, x + bx, y + dh - by, dmw, by);
    ctx.drawImage(src, sw - bx, sh - by, bx, by, x + dw - bx, y + dh - by, bx, by);
    var mx = mouse.x - uiScrollOffset.x, my = mouse.y - uiScrollOffset.y;
    if (mx >= x && mx <= x + dw && my >= y && my <= y + dh) mouse.overUi = true;
  }

  function scrollBegin(id, x, y, w, h, contentH) {
    var key = String(id || 'scroll');
    if (!scrollStates[key]) scrollStates[key] = { y: 0, dragging: false, lastMy: 0 };
    var st = scrollStates[key];
    var maxScroll = Math.max(0, (Number(contentH) || 0) - (Number(h) || 100));
    var mx = mouse.x - uiScrollOffset.x, my = mouse.y - uiScrollOffset.y;
    var inside = mx >= x && mx <= x + w && my >= y && my <= y + h;
    if (inside) {
      mouse.overUi = true;
      if (mouse.wheel !== 0) st.y += mouse.wheel * 0.55;
      if (mouse.clicked) { st.dragging = true; st.lastMy = mouse.y; }
    }
    if (st.dragging) {
      if (mouse.down) { st.y -= (mouse.y - st.lastMy); st.lastMy = mouse.y; }
      else st.dragging = false;
    }
    st.y = Math.max(0, Math.min(maxScroll, st.y));
    uiScrollOffset.stack.push({ x: uiScrollOffset.x, y: uiScrollOffset.y, bx: x, by: y, bw: w, bh: h, maxS: maxScroll, curS: st.y });
    uiScrollOffset.y -= st.y;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.translate(0, -st.y);
    return st.y;
  }

  function scrollEnd() {
    ctx.restore();
    var info = uiScrollOffset.stack.pop();
    if (info) {
      uiScrollOffset.x = info.x;
      uiScrollOffset.y = info.y;
      if (info.maxS > 0) {
        var barH = Math.max(20, (info.bh / (info.bh + info.maxS)) * (info.bh - 8));
        var barY = info.by + 4 + (info.curS / info.maxS) * (info.bh - 8 - barH);
        drawRect(info.bx + info.bw - 6, info.by + 4, 4, info.bh - 8, 'rgba(30,41,59,0.55)', 2);
        drawRect(info.bx + info.bw - 6, barY, 4, barH, '#38bdf8', 2);
      }
    }
  }

  function slider(val, minVal, maxVal, x, y, w, col) {
    var o = isOptsObj(w) ? w : null;
    var sw = Number(o ? (o.w || o.width) : w) || 180;
    var fillC = (o ? (o.color || o.col) : col) || '#38bdf8';
    var mn = Number(minVal) || 0, mxV = maxVal === undefined ? 100 : Number(maxVal);
    var span = (mxV - mn) || 1;
    var v = Math.max(mn, Math.min(mxV, Number(val) || 0));
    var id = (o && o.id) ? String(o.id) : ('sl_' + Math.round(x) + '_' + Math.round(y) + '_' + Math.round(sw));
    var mx = mouse.x - uiScrollOffset.x, my = mouse.y - uiScrollOffset.y;
    var hov = isUiClipSafe(mouse.x, mouse.y) && mx >= x - 8 && mx <= x + sw + 8 && my >= y - 10 && my <= y + 18;
    if (hov) mouse.overUi = true;
    if (hov && mouse.clicked) activeSliderId = id;
    if (!mouse.down && activeSliderId === id) activeSliderId = null;
    if (activeSliderId === id) {
      var ratioNew = Math.max(0, Math.min(1, (mx - x) / sw));
      v = mn + ratioNew * span;
    }
    var ratio = Math.max(0, Math.min(1, (v - mn) / span));
    drawRect(x, y + 2, sw, 6, '#1e293b', 3);
    if (ratio > 0) drawRect(x, y + 2, sw * ratio, 6, fillC, 3);
    drawCircle(x + sw * ratio, y + 5, hov || activeSliderId === id ? 9 : 7, '#ffffff');
    strokeCircle(x + sw * ratio, y + 5, hov || activeSliderId === id ? 9 : 7, fillC, 2);
    return v;
  }

  function toggle(label, val, x, y, col) {
    var on = !!val;
    var mx = mouse.x - uiScrollOffset.x, my = mouse.y - uiScrollOffset.y;
    var lblW = measureTextBox(label || '', 14).width;
    var hov = isUiClipSafe(mouse.x, mouse.y) && mx >= x && mx <= x + 46 + (label ? lblW + 10 : 0) && my >= y && my <= y + 24;
    if (hov) mouse.overUi = true;
    var ac = col || '#10b981';
    drawRect(x, y, 44, 24, on ? ac : '#334155', 12);
    drawCircle(on ? x + 32 : x + 12, y + 12, 9, '#ffffff');
    if (label) text(label, x + 52, y + 4, hov ? '#ffffff' : '#cbd5e1', 14, 'left');
    if (hov && mouse.clicked) return !on;
    return on;
  }

  function drawArc(x, y, r, startAng, endAng, color, lw, fillColor) {
    var o = isOptsObj(color) ? color : null;
    var strokeC = o ? (o.color !== undefined ? o.color : o.stroke) : color;
    var lineW = o ? (o.lw || o.lineWidth || 3) : (lw || 3);
    var fillC = o ? (o.fill || o.fillColor || o.fillCol || null) : fillColor;
    var rad = Math.max(0, Number(r) || 16);
    ctx.beginPath();
    if (fillC) ctx.moveTo(x, y);
    ctx.arc(x, y, rad, Number(startAng) || 0, Number(endAng) || Math.PI * 2);
    if (fillC) { ctx.closePath(); ctx.fillStyle = fillC; ctx.fill(); }
    if (strokeC !== null) { ctx.strokeStyle = strokeC || '#38bdf8'; ctx.lineWidth = lineW; ctx.stroke(); }
  }

  function drawRing(x, y, innerR, outerR, color) {
    var rIn = Math.max(0, Number(innerR) || 8), rOut = Math.max(rIn + 1, Number(outerR) || 16);
    ctx.beginPath();
    ctx.arc(x, y, rOut, 0, Math.PI * 2, false);
    ctx.arc(x, y, rIn, 0, Math.PI * 2, true);
    ctx.fillStyle = color || '#38bdf8';
    ctx.fill();
  }

  function drawEllipse(x, y, rx, ry, color, rot, strokeCol, lw) {
    var o = isOptsObj(color) ? color : null;
    var fillC = o ? (o.color !== undefined ? o.color : o.fill) : color;
    var rAng = Number(o ? (o.rot !== undefined ? o.rot : o.rotation) : rot) || 0;
    var sCol = o ? (o.stroke || o.strokeCol || o.strokeColor) : strokeCol;
    var lineW = o ? (o.lw || o.lineWidth || 2) : (lw || 2);
    ctx.beginPath();
    ctx.ellipse(x, y, Math.max(0, Number(rx) || 16), Math.max(0, Number(ry) || 10), rAng, 0, Math.PI * 2);
    if (fillC) { ctx.fillStyle = fillC; ctx.fill(); }
    if (sCol) { ctx.strokeStyle = sCol; ctx.lineWidth = lineW; ctx.stroke(); }
  }

  function drawCurve(x1, y1, cx, cy, x2, y2, color, lw) {
    ctx.strokeStyle = color || '#38bdf8';
    ctx.lineWidth = lw || 2.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.quadraticCurveTo(cx, cy, x2, y2);
    ctx.stroke();
  }

  function drawBezier(x1, y1, cx1, cy1, cx2, cy2, x2, y2, color, lw) {
    ctx.strokeStyle = color || '#38bdf8';
    ctx.lineWidth = lw || 2.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.bezierCurveTo(cx1, cy1, cx2, cy2, x2, y2);
    ctx.stroke();
  }

  function drawPath(pts, color, lw, closed) {
    if (!Array.isArray(pts) || pts.length < 2) return;
    ctx.beginPath();
    for (var i = 0; i < pts.length; i++) {
      var pt = pts[i];
      var px = Array.isArray(pt) ? pt[0] : pt.x;
      var py = Array.isArray(pt) ? pt[1] : pt.y;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    if (closed) ctx.closePath();
    ctx.strokeStyle = color || '#38bdf8';
    ctx.lineWidth = lw || 2.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  function drawRadialGradient(x, y, r1, r2, c1, c2) {
    var rad2 = Math.max(1, Number(r2) || 40);
    var grad = ctx.createRadialGradient(x, y, Math.max(0, Number(r1) || 0), x, y, rad2);
    grad.addColorStop(0, c1 || '#38bdf8');
    grad.addColorStop(1, c2 || 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, rad2, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawTrail(points, wStart, wEnd, cStart, cEnd) {
    if (!Array.isArray(points) || points.length < 2) return;
    var o = isOptsObj(wStart) ? wStart : null;
    var ws = Number(o ? (o.wStart !== undefined ? o.wStart : o.width) : wStart) || 10;
    var we = Number(o ? (o.wEnd !== undefined ? o.wEnd : 1) : (wEnd === undefined ? 1 : wEnd));
    var cs = (o ? (o.cStart || o.color) : cStart) || '#38bdf8';
    var ce = (o ? (o.cEnd || o.colorEnd) : cEnd) || cs;
    var n = points.length;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (var i = 0; i < n - 1; i++) {
      var p0 = points[i], p1 = points[i + 1];
      var x0 = Array.isArray(p0) ? p0[0] : p0.x, y0 = Array.isArray(p0) ? p0[1] : p0.y;
      var x1 = Array.isArray(p1) ? p1[0] : p1.x, y1 = Array.isArray(p1) ? p1[1] : p1.y;
      var t = n > 2 ? i / (n - 2) : 1;
      var segW = ws + (we - ws) * t;
      if (segW <= 0.1) continue;
      ctx.strokeStyle = cs === ce ? cs : lerpColor(cs, ce, t);
      ctx.lineWidth = segW;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
    ctx.restore();
  }

  function createLayer(lw, lh) {
    var cw = Math.max(1, Math.floor(Number(lw) || W));
    var ch = Math.max(1, Math.floor(Number(lh) || H));
    var lDpr = DPR;
    var off = document.createElement('canvas');
    off.width = Math.round(cw * lDpr); off.height = Math.round(ch * lDpr);
    var octx = off.getContext('2d');
    octx.setTransform(lDpr, 0, 0, lDpr, 0, 0);
    var prevCtx = null;
    return {
      width: cw, height: ch, canvas: off,
      begin: function() { prevCtx = ctx; ctx = octx; },
      end: function() { ctx = prevCtx || frameBaseCtx || rootCtx; prevCtx = null; },
      clear: function(col) {
        octx.save();
        octx.setTransform(lDpr, 0, 0, lDpr, 0, 0);
        if (col) { octx.fillStyle = col; octx.fillRect(0, 0, cw, ch); }
        else octx.clearRect(0, 0, cw, ch);
        octx.restore();
      },
      draw: function(px, py, rot, sx, sy) {
        var x0 = px || 0, y0 = py || 0;
        var scaleX = (sx === undefined || sx === null) ? 1 : Number(sx);
        var scaleY = scaleX;
        if (typeof sy === 'boolean') {
          if (sy) scaleX = -Math.abs(scaleX);
        } else if (sy !== undefined && sy !== null) {
          scaleY = Number(sy);
        }
        if (!rot && scaleX === 1 && scaleY === 1) {
          ctx.drawImage(off, 0, 0, off.width, off.height, x0, y0, cw, ch);
        } else {
          ctx.save();
          ctx.translate(x0 + (cw * Math.abs(scaleX)) / 2, y0 + (ch * Math.abs(scaleY)) / 2);
          if (rot) ctx.rotate(rot);
          ctx.scale(scaleX, scaleY);
          ctx.drawImage(off, 0, 0, off.width, off.height, -cw / 2, -ch / 2, cw, ch);
          ctx.restore();
        }
      }
    };
  }

  function beginScreenSpace() {
    if (ctx === frameBaseCtx || ctx === rootCtx) ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }

  function beginWorldSpace() {
    if (ctx !== frameBaseCtx && ctx !== rootCtx) return;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    if (frameCamTransform.active) {
      ctx.translate(W / 2 + frameCamTransform.ox, H / 2 + frameCamTransform.oy);
      ctx.scale(cam.zoom, cam.zoom);
      ctx.translate(-W / 2 - cam.x, -H / 2 - cam.y);
    }
  }

  function pathfindGrid(gridSrc, sx, sy, tx, ty, wallSpec, allowDiag) {
    var rows = gridSrc && gridSrc._rows ? gridSrc._rows : gridSrc;
    if (!Array.isArray(rows) || !rows.length) return [];
    var gh = rows.length;
    var gw = Array.isArray(rows[0]) ? rows[0].length : String(rows[0] || '').length;
    var x0 = Math.floor(sx), y0 = Math.floor(sy), x1 = Math.floor(tx), y1 = Math.floor(ty);
    if (x0 < 0 || x0 >= gw || y0 < 0 || y0 >= gh || x1 < 0 || x1 >= gw || y1 < 0 || y1 >= gh) return [];
    function isWall(cx, cy) {
      var v = Array.isArray(rows[cy]) ? rows[cy][cx] : String(rows[cy])[cx];
      if (typeof wallSpec === 'function') return !!wallSpec(v, cx, cy);
      if (wallSpec === undefined) {
        if (gridSrc && gridSrc._isTilemap && typeof gridSrc._isSolidChar === 'function') return gridSrc._isSolidChar(v);
        return v === '#' || v === 1 || v === true;
      }
      if (typeof wallSpec === 'string') return wallSpec.indexOf(String(v)) >= 0;
      return v === wallSpec;
    }
    if (isWall(x1, y1)) return [];
    if (x0 === x1 && y0 === y1) return [[x0, y0]];
    var total = gw * gh;
    var gScore = new Float64Array(total);
    var closed = new Uint8Array(total);
    var parent = new Int32Array(total);
    for (var i = 0; i < total; i++) { gScore[i] = 1e9; parent[i] = -1; }
    var startId = y0 * gw + x0, goalId = y1 * gw + x1;
    gScore[startId] = 0;
    var open = [{ id: startId, f: Math.abs(x1 - x0) + Math.abs(y1 - y0) }];
    var dirs = allowDiag
      ? [[1,0,1],[-1,0,1],[0,1,1],[0,-1,1],[1,1,1.414],[-1,1,1.414],[1,-1,1.414],[-1,-1,1.414]]
      : [[1,0,1],[-1,0,1],[0,1,1],[0,-1,1]];
    var exp = 0;
    while (open.length > 0 && exp < 4500) {
      exp++;
      var bestIdx = 0;
      for (var oi = 1; oi < open.length; oi++) { if (open[oi].f < open[bestIdx].f) bestIdx = oi; }
      var cur = open.splice(bestIdx, 1)[0].id;
      if (cur === goalId) {
        var out = [];
        var cId = goalId;
        while (cId >= 0) {
          out.push([cId % gw, Math.floor(cId / gw)]);
          cId = parent[cId];
        }
        return out.reverse();
      }
      if (closed[cur]) continue;
      closed[cur] = 1;
      var cx = cur % gw, cy = Math.floor(cur / gw);
      for (var d = 0; d < dirs.length; d++) {
        var nx = cx + dirs[d][0], ny = cy + dirs[d][1];
        if (nx < 0 || nx >= gw || ny < 0 || ny >= gh) continue;
        var nid = ny * gw + nx;
        if (closed[nid] || isWall(nx, ny)) continue;
        var ng = gScore[cur] + dirs[d][2];
        if (ng < gScore[nid]) {
          gScore[nid] = ng;
          parent[nid] = cur;
          open.push({ id: nid, f: ng + Math.abs(x1 - nx) + Math.abs(y1 - ny) });
        }
      }
    }
    return [];
  }

  function flowField(gridSrc, tx, ty, wallSpec, allowDiag) {
    var rows = gridSrc && gridSrc._rows ? gridSrc._rows : gridSrc;
    if (!Array.isArray(rows) || !rows.length) {
      return { dirAt: function() { return [0, 0]; }, dirWorld: function() { return [0, 0]; }, distAt: function() { return 999999; }, invalidate: function() {} };
    }
    var gh = rows.length;
    var gw = Array.isArray(rows[0]) ? rows[0].length : String(rows[0] || '').length;
    var gx0 = Math.max(0, Math.min(gw - 1, Math.floor(tx)));
    var gy0 = Math.max(0, Math.min(gh - 1, Math.floor(ty)));
    var wallKey = typeof wallSpec === 'function' ? 'fn' : String(wallSpec === undefined ? 'auto' : wallSpec);
    var cKey = gw + 'x' + gh + ':' + gx0 + ',' + gy0 + ':' + wallKey + ':' + (allowDiag ? 1 : 0);
    var cached = flowFieldCache[cKey];
    if (cached && cached.rows === rows) return cached.field;

    function isWallCell(cx, cy) {
      var v = Array.isArray(rows[cy]) ? rows[cy][cx] : String(rows[cy])[cx];
      if (typeof wallSpec === 'function') return !!wallSpec(v, cx, cy);
      if (wallSpec === undefined) {
        if (gridSrc && gridSrc._isTilemap && typeof gridSrc._isSolidChar === 'function') return gridSrc._isSolidChar(v);
        return v === '#' || v === 1 || v === true;
      }
      if (typeof wallSpec === 'string') return wallSpec.indexOf(String(v)) >= 0;
      return v === wallSpec;
    }

    var total = gw * gh;
    var distArr = new Int32Array(total);
    var dirXArr = new Float32Array(total);
    var dirYArr = new Float32Array(total);
    for (var i = 0; i < total; i++) distArr[i] = 999999;
    var q = new Int32Array(total);
    var qh = 0, qt = 0;
    if (!isWallCell(gx0, gy0)) {
      var sid = gy0 * gw + gx0;
      distArr[sid] = 0;
      q[qt++] = sid;
    }
    var dirs4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    var dirs8 = allowDiag ? [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]] : dirs4;
    while (qh < qt) {
      var cur = q[qh++];
      var cx = cur % gw, cy = Math.floor(cur / gw);
      var nd = distArr[cur] + 1;
      for (var d = 0; d < dirs4.length; d++) {
        var nx = cx + dirs4[d][0], ny = cy + dirs4[d][1];
        if (nx < 0 || nx >= gw || ny < 0 || ny >= gh) continue;
        var nid = ny * gw + nx;
        if (distArr[nid] > nd && !isWallCell(nx, ny)) {
          distArr[nid] = nd;
          q[qt++] = nid;
        }
      }
    }
    for (var py = 0; py < gh; py++) {
      for (var px = 0; px < gw; px++) {
        var id = py * gw + px;
        if (distArr[id] >= 999999 || distArr[id] === 0) continue;
        var bestD = distArr[id], bx = 0, by = 0;
        for (var k = 0; k < dirs8.length; k++) {
          var kx = px + dirs8[k][0], ky = py + dirs8[k][1];
          if (kx < 0 || kx >= gw || ky < 0 || ky >= gh) continue;
          var kd = distArr[ky * gw + kx];
          if (kd < bestD) { bestD = kd; bx = dirs8[k][0]; by = dirs8[k][1]; }
        }
        var ln = Math.hypot(bx, by);
        if (ln > 0) { dirXArr[id] = bx / ln; dirYArr[id] = by / ln; }
      }
    }
    var fieldObj = {
      width: gw, height: gh, targetX: gx0, targetY: gy0,
      dirAt: function(gx, gy) {
        var ix = Math.floor(gx), iy = Math.floor(gy);
        if (ix < 0 || ix >= gw || iy < 0 || iy >= gh) return [0, 0];
        var idx = iy * gw + ix;
        return [dirXArr[idx], dirYArr[idx]];
      },
      dirWorld: function(wx, wy, tileSize) {
        var ts = Number(tileSize) || (gridSrc && gridSrc.tileSize) || 32;
        return fieldObj.dirAt(wx / ts, wy / ts);
      },
      distAt: function(gx, gy) {
        var ix = Math.floor(gx), iy = Math.floor(gy);
        if (ix < 0 || ix >= gw || iy < 0 || iy >= gh) return 999999;
        return distArr[iy * gw + ix];
      },
      invalidate: function() { delete flowFieldCache[cKey]; }
    };
    flowFieldCache[cKey] = { rows: rows, field: fieldObj };
    return fieldObj;
  }

  function pathfindAsync(gridSrc, sx, sy, tx, ty, wallSpec, allowDiag, budgetPerFrame) {
    var budget = Math.max(20, Math.min(2000, Number(budgetPerFrame) || 180));
    var rows = gridSrc && gridSrc._rows ? gridSrc._rows : gridSrc;
    if (!Array.isArray(rows) || !rows.length) return Promise.resolve([]);
    var gh = rows.length;
    var gw = Array.isArray(rows[0]) ? rows[0].length : String(rows[0] || '').length;
    var x0 = Math.floor(sx), y0 = Math.floor(sy), x1 = Math.floor(tx), y1 = Math.floor(ty);
    if (x0 < 0 || x0 >= gw || y0 < 0 || y0 >= gh || x1 < 0 || x1 >= gw || y1 < 0 || y1 >= gh) return Promise.resolve([]);
    function isWallA(cx, cy) {
      var v = Array.isArray(rows[cy]) ? rows[cy][cx] : String(rows[cy])[cx];
      if (typeof wallSpec === 'function') return !!wallSpec(v, cx, cy);
      if (wallSpec === undefined) {
        if (gridSrc && gridSrc._isTilemap && typeof gridSrc._isSolidChar === 'function') return gridSrc._isSolidChar(v);
        return v === '#' || v === 1 || v === true;
      }
      if (typeof wallSpec === 'string') return wallSpec.indexOf(String(v)) >= 0;
      return v === wallSpec;
    }
    if (isWallA(x1, y1)) return Promise.resolve([]);
    if (x0 === x1 && y0 === y1) return Promise.resolve([[x0, y0]]);
    var total = gw * gh;
    var gScore = new Float64Array(total);
    var closed = new Uint8Array(total);
    var parent = new Int32Array(total);
    for (var i = 0; i < total; i++) { gScore[i] = 1e9; parent[i] = -1; }
    var startId = y0 * gw + x0, goalId = y1 * gw + x1;
    gScore[startId] = 0;
    var open = [{ id: startId, f: Math.abs(x1 - x0) + Math.abs(y1 - y0) }];
    var dirs = allowDiag
      ? [[1,0,1],[-1,0,1],[0,1,1],[0,-1,1],[1,1,1.414],[-1,1,1.414],[1,-1,1.414],[-1,-1,1.414]]
      : [[1,0,1],[-1,0,1],[0,1,1],[0,-1,1]];
    var exp = 0;
    return new Promise(function(resolve) {
      function stepChunk() {
        var chunk = 0;
        while (open.length > 0 && exp < 25000 && chunk < budget) {
          exp++; chunk++;
          var bestIdx = 0;
          for (var oi = 1; oi < open.length; oi++) { if (open[oi].f < open[bestIdx].f) bestIdx = oi; }
          var cur = open.splice(bestIdx, 1)[0].id;
          if (cur === goalId) {
            var out = [];
            var cId = goalId;
            while (cId >= 0) { out.push([cId % gw, Math.floor(cId / gw)]); cId = parent[cId]; }
            resolve(out.reverse());
            return;
          }
          if (closed[cur]) continue;
          closed[cur] = 1;
          var cx = cur % gw, cy = Math.floor(cur / gw);
          for (var d = 0; d < dirs.length; d++) {
            var nx = cx + dirs[d][0], ny = cy + dirs[d][1];
            if (nx < 0 || nx >= gw || ny < 0 || ny >= gh) continue;
            var nid = ny * gw + nx;
            if (closed[nid] || isWallA(nx, ny)) continue;
            var ng = gScore[cur] + dirs[d][2];
            if (ng < gScore[nid]) {
              gScore[nid] = ng; parent[nid] = cur;
              open.push({ id: nid, f: ng + Math.abs(x1 - nx) + Math.abs(y1 - ny) });
            }
          }
        }
        if (open.length === 0 || exp >= 25000) resolve([]);
        else setTimeout(stepChunk, 0);
      }
      stepChunk();
    });
  }

  function zoomAt(nextZoom, sx, sy) {
    var prevZ = cam.zoom || 1;
    var z = Math.max(0.15, Math.min(8, Number(nextZoom) || 1));
    var px = sx === undefined ? W / 2 : Number(sx);
    var py = sy === undefined ? H / 2 : Number(sy);
    var wx = (px - W / 2) / prevZ + W / 2 + cam.x;
    var wy = (py - H / 2) / prevZ + H / 2 + cam.y;
    cam.zoom = z;
    cam.x = wx - W / 2 - (px - W / 2) / z;
    cam.y = wy - H / 2 - (py - H / 2) / z;
    return cam.zoom;
  }

  function getCamera() {
    return { x: cam.x, y: cam.y, zoom: cam.zoom || 1 };
  }
  function camX() { return cam.x; }
  function camY() { return cam.y; }
  function camZoom() { return cam.zoom || 1; }
  function inView(xOrEnt, yOrPad, padOrW, hOpt) {
    var z = cam.zoom || 1;
    var hw = (W / 2) / z, hh = (H / 2) / z;
    var cx = cam.x + W / 2, cy = cam.y + H / 2;
    var vMinX = cx - hw, vMaxX = cx + hw, vMinY = cy - hh, vMaxY = cy + hh;
    if (xOrEnt && typeof xOrEnt === 'object') {
      var pad = Number(yOrPad) || 48;
      var ex = Number(xOrEnt.x) || 0, ey = Number(xOrEnt.y) || 0;
      if (xOrEnt._shape === 'circle' || (xOrEnt.r !== undefined && !xOrEnt.w)) {
        var r = (Number(xOrEnt.r) || 16) + pad;
        return ex + r >= vMinX && ex - r <= vMaxX && ey + r >= vMinY && ey - r <= vMaxY;
      }
      var ew = Number(xOrEnt.w) || 0, eh = Number(xOrEnt.h) || 0;
      return ex + ew + pad >= vMinX && ex - pad <= vMaxX && ey + eh + pad >= vMinY && ey - pad <= vMaxY;
    }
    var px = Number(xOrEnt) || 0, py = Number(yOrPad) || 0;
    if (hOpt !== undefined) {
      var rw = Number(padOrW) || 0, rh = Number(hOpt) || 0;
      return px + rw >= vMinX && px <= vMaxX && py + rh >= vMinY && py <= vMaxY;
    }
    var padN = padOrW === undefined ? 48 : Number(padOrW) || 0;
    return px >= vMinX - padN && px <= vMaxX + padN && py >= vMinY - padN && py <= vMaxY + padN;
  }

  function showToast(msg, col, durMs) {
    var d = Math.max(0.4, (Number(durMs) || 2400) / 1000);
    toastQueue.push({ text: String(msg || ''), color: col || '#38bdf8', rem: d, dur: d });
    if (toastQueue.length > 5) toastQueue.shift();
    if (sdk && sdk.ui && typeof sdk.ui.toast === 'function') {
      try { sdk.ui.toast(msg, col); } catch(e) {}
    }
  }

  function strokeRect(x, y, w, h, color, lw) {
    ctx.strokeStyle = color || '#ffffff';
    ctx.lineWidth = lw || 2;
    ctx.strokeRect(x, y, w, h);
  }

  function drawCircle(x, y, r, color) {
    ctx.fillStyle = color || '#38bdf8';
    ctx.beginPath();
    ctx.arc(x, y, Math.max(0, r || 8), 0, Math.PI * 2);
    ctx.fill();
  }

  function strokeCircle(x, y, r, color, lw) {
    ctx.strokeStyle = color || '#ffffff';
    ctx.lineWidth = lw || 2;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(0, r || 8), 0, Math.PI * 2);
    ctx.stroke();
  }

  function drawLine(x1, y1, x2, y2, color, lw) {
    ctx.strokeStyle = color || '#ffffff';
    ctx.lineWidth = lw || 2;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  function drawPoly(pts, color, strokeCol, lw) {
    if (!Array.isArray(pts) || pts.length < 2) return;
    ctx.beginPath();
    for (var i = 0; i < pts.length; i++) {
      var pt = pts[i];
      var px = Array.isArray(pt) ? pt[0] : pt.x;
      var py = Array.isArray(pt) ? pt[1] : pt.y;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    if (color) { ctx.fillStyle = color; ctx.fill(); }
    if (strokeCol) { ctx.strokeStyle = strokeCol; ctx.lineWidth = lw || 2; ctx.stroke(); }
  }

  function drawStar(cx, cy, spikes, outerR, innerR, color, rot) {
    var sp = Math.max(3, Math.floor(spikes || 5));
    var oR = Number(outerR) || 20, iR = Number(innerR) || oR * 0.45;
    var a0 = (Number(rot) || 0) - Math.PI / 2;
    ctx.beginPath();
    for (var i = 0; i < sp * 2; i++) {
      var rad = (i % 2 === 0) ? oR : iR;
      var ang = a0 + (i * Math.PI) / sp;
      var px = cx + Math.cos(ang) * rad;
      var py = cy + Math.sin(ang) * rad;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = color || '#fbbf24';
    ctx.fill();
  }

  function drawBar(x, y, w, h, ratio, fillCol, bgCol, radius) {
    var o = isOptsObj(fillCol) ? fillCol : null;
    var fCol = o ? (o.fill || o.fillCol || o.color) : fillCol;
    var bCol = o ? (o.bg || o.bgCol) : bgCol;
    var rad = o && (o.radius !== undefined || o.r !== undefined) ? (o.radius !== undefined ? o.radius : o.r) : (radius || 4);
    var brd = o ? (o.border || o.borderCol) : null;
    var r = Math.max(0, Math.min(1, Number(ratio) || 0));
    drawRect(x, y, w, h, bCol || 'rgba(15,23,42,0.85)', rad);
    if (r > 0) drawRect(x, y, w * r, h, fCol || '#34d399', rad);
    if (brd) strokeRect(x, y, w, h, brd, 1.5);
  }

  function drawGrid(cellSize, color, lw) {
    var s = Math.max(4, Number(cellSize) || 32);
    ctx.strokeStyle = color || 'rgba(148,163,184,0.14)';
    ctx.lineWidth = lw || 1;
    ctx.beginPath();
    for (var gx = 0; gx <= W; gx += s) { ctx.moveTo(gx, 0); ctx.lineTo(gx, H); }
    for (var gy = 0; gy <= H; gy += s) { ctx.moveTo(0, gy); ctx.lineTo(W, gy); }
    ctx.stroke();
  }

  function text(str, x, y, color, size, align) {
    var o = isOptsObj(color) ? color : null;
    var col = o ? (o.color || o.fill) : color;
    var sz = o ? Number(o.size || 18) : (Number(size) || 18);
    var al = o ? (o.align || 'left') : (align || 'left');
    ctx.fillStyle = col || '#f8fafc';
    ctx.font = '700 ' + sz + 'px ' + (o && o.font ? o.font : fontFamily);
    ctx.textAlign = al;
    ctx.textBaseline = (o && o.baseline) ? o.baseline : 'top';
    ctx.fillText(String(str === undefined ? '' : str), x, y);
  }

  function textStroke(str, x, y, color, strokeColor, size, align, lw) {
    var s = String(str === undefined ? '' : str);
    var o = isOptsObj(color) ? color : null;
    var col = o ? (o.color || o.fill) : color;
    var sCol = o ? (o.stroke || o.strokeColor) : strokeColor;
    var sz = Number(o ? o.size : size) || 20;
    var al = (o ? o.align : align) || 'left';
    var lineW = Number(o ? (o.lw !== undefined ? o.lw : o.lineWidth) : lw) || 4;
    ctx.font = '800 ' + sz + 'px ' + fontFamily;
    ctx.textAlign = al;
    ctx.textBaseline = (o && o.baseline) ? o.baseline : 'top';
    ctx.lineJoin = 'round';
    ctx.lineWidth = lineW;
    ctx.strokeStyle = sCol || '#020617';
    ctx.strokeText(s, x, y);
    ctx.fillStyle = col || '#f8fafc';
    ctx.fillText(s, x, y);
  }

  function measureTextBox(str, size) {
    var sz = Number(size) || 18;
    ctx.font = '700 ' + sz + 'px ' + fontFamily;
    var m = ctx.measureText(String(str === undefined ? '' : str));
    return { width: m.width, height: sz * 1.25 };
  }

  function textWrap(str, x, y, maxW, color, size, align, lineH) {
    var o = isOptsObj(maxW) ? maxW : (isOptsObj(color) ? color : null);
    var mw = Math.max(20, Number(o && maxW === o ? (o.maxW || o.width) : maxW) || 240);
    var col = o ? (o.color || o.fill) : color;
    var sz = Number(o ? o.size : size) || 16;
    var al = (o ? o.align : align) || 'left';
    var lh = Number(o ? (o.lineH || o.lineHeight) : lineH) || Math.round(sz * 1.32);
    ctx.fillStyle = col || '#f8fafc';
    ctx.font = '700 ' + sz + 'px ' + fontFamily;
    ctx.textAlign = al;
    ctx.textBaseline = 'top';
    var paragraphs = String(str === undefined ? '' : str).split('\\n');
    var curY = y;
    for (var p = 0; p < paragraphs.length; p++) {
      var words = paragraphs[p].split(' ');
      var line = '';
      for (var i = 0; i < words.length; i++) {
        var test = line ? line + ' ' + words[i] : words[i];
        if (ctx.measureText(test).width > mw && line) {
          ctx.fillText(line, x, curY);
          line = words[i];
          curY += lh;
        } else {
          line = test;
        }
      }
      ctx.fillText(line, x, curY);
      curY += lh;
    }
    return curY - y;
  }

  function sprite(rows, palette, scale) {
    var sc = Math.max(1, Number(scale) || 3);
    var list = Array.isArray(rows) ? rows : String(rows || '').split('\\n');
    var pal = palette || { '#': '#38bdf8', A: '#38bdf8', B: '#f8fafc', C: '#fbbf24', R: '#ef4444', G: '#34d399' };
    var maxCols = 0;
    for (var r = 0; r < list.length; r++) {
      if (list[r].length > maxCols) maxCols = list[r].length;
    }
    var cw = Math.max(1, maxCols * sc), ch = Math.max(1, list.length * sc);
    var off = document.createElement('canvas');
    off.width = cw; off.height = ch;
    var octx = off.getContext('2d');
    octx.imageSmoothingEnabled = false;
    for (var y = 0; y < list.length; y++) {
      var rowStr = list[y];
      for (var x = 0; x < rowStr.length; x++) {
        var chKey = rowStr[x];
        if (chKey === ' ' || chKey === '.') continue;
        var col = pal[chKey];
        if (col) {
          octx.fillStyle = col;
          octx.fillRect(x * sc, y * sc, sc, sc);
        }
      }
    }
    return {
      width: cw, height: ch, canvas: off,
      draw: function(px, py, rot, scaleMul, flipX) {
        var sm = Number(scaleMul) || 1;
        ctx.save();
        ctx.imageSmoothingEnabled = false;
        ctx.translate((px || 0) + (cw * sm) / 2, (py || 0) + (ch * sm) / 2);
        if (rot) ctx.rotate(rot);
        ctx.scale(flipX ? -sm : sm, sm);
        ctx.drawImage(off, -cw / 2, -ch / 2);
        ctx.restore();
      }
    };
  }

  function anim(srcOrArr, fwOrOpts, fhOpt, clipsOpt) {
    var isArr = Array.isArray(srcOrArr);
    var opts = isOptsObj(fwOrOpts) ? fwOrOpts : (isOptsObj(clipsOpt) ? clipsOpt : {});
    var fw = !isArr && typeof fwOrOpts === 'number' ? Math.max(1, fwOrOpts) : (Number(opts.fw) || 32);
    var fh = !isArr && typeof fhOpt === 'number' ? Math.max(1, fhOpt) : (Number(opts.fh) || fw);
    var clipsInput = isOptsObj(clipsOpt) ? clipsOpt : (isOptsObj(fwOrOpts) ? (fwOrOpts.clips || fwOrOpts) : {});
    var clipMap = {};
    if (isArr) {
      clipMap.default = { frames: srcOrArr.map(function(_, i) { return i; }), fps: Number(opts.fps) || 8, loop: opts.loop !== false };
    } else if (clipsInput && typeof clipsInput === 'object') {
      Object.keys(clipsInput).forEach(function(ck) {
        if (ck === 'fw' || ck === 'fh' || ck === 'fps' || ck === 'loop') return;
        var cv = clipsInput[ck];
        if (Array.isArray(cv)) clipMap[ck] = { frames: cv.slice(), fps: Number(opts.fps) || 8, loop: true };
        else if (cv && typeof cv === 'object') {
          var fList = Array.isArray(cv.frames) ? cv.frames.slice() : [0];
          clipMap[ck] = { frames: fList, row: cv.row, fps: Math.max(0.5, Number(cv.fps) || 8), loop: cv.loop !== false };
        }
      });
    }
    var firstKey = Object.keys(clipMap)[0] || 'default';
    if (!clipMap[firstKey]) clipMap[firstKey] = { frames: [0], fps: 8, loop: true };

    var st = {
      clip: firstKey, idx: 0, acc: 0, finished: false, lastTickFrame: -1,
      play: function(name, restart) {
        var nm = String(name || firstKey);
        if (!clipMap[nm]) return st;
        if (st.clip !== nm || restart) {
          st.clip = nm; st.idx = 0; st.acc = 0; st.finished = false;
        }
        return st;
      },
      setClip: function(name, def) {
        clipMap[name] = Array.isArray(def) ? { frames: def.slice(), fps: 8, loop: true } : def;
        return st;
      },
      update: function(dt) {
        if (st.lastTickFrame === totalFrames) return;
        st.lastTickFrame = totalFrames;
        var c = clipMap[st.clip] || clipMap[firstKey];
        if (!c || !c.frames.length || st.finished) return;
        st.acc += Math.max(0, Number(dt) || 0);
        var step = 1 / Math.max(0.5, c.fps || 8);
        while (st.acc >= step) {
          st.acc -= step;
          if (st.idx + 1 < c.frames.length) st.idx++;
          else if (c.loop !== false) st.idx = 0;
          else { st.idx = c.frames.length - 1; st.finished = true; break; }
        }
      },
      draw: function(px, py, rot, scaleMul, flipX) {
        var c = clipMap[st.clip] || clipMap[firstKey];
        if (!c || !c.frames.length) return;
        var frameVal = c.frames[Math.max(0, Math.min(c.frames.length - 1, st.idx))];
        if (isArr) {
          var item = srcOrArr[frameVal];
          if (item && typeof item.draw === 'function') item.draw(px, py, rot, scaleMul, flipX);
          return;
        }
        if (srcOrArr && typeof srcOrArr.drawFrame === 'function') {
          var row = c.row !== undefined ? c.row : 0;
          var col = frameVal;
          if (Array.isArray(frameVal)) { col = frameVal[0] || 0; row = frameVal[1] || 0; }
          srcOrArr.drawFrame(col, row, fw, fh, px, py, rot, scaleMul, flipX);
        }
      }
    };
    activeAnims.push(st);
    return st;
  }

  function pool(maxSize, factoryFn) {
    var cap = Math.max(1, Math.min(5000, Number(maxSize) || 128));
    var factory = typeof factoryFn === 'function' ? factoryFn : function() { return {}; };
    var items = [];
    for (var i = 0; i < cap; i++) {
      var o = factory(i) || {};
      o.alive = false;
      items.push(o);
    }
    var pObj = {
      items: items,
      capacity: cap,
      spawn: function(initPropsOrFn) {
        var chosen = null;
        for (var i = 0; i < items.length; i++) {
          if (!items[i] || items[i].alive === false) { chosen = items[i]; break; }
        }
        if (!chosen) return null;
        chosen.alive = true;
        if (typeof initPropsOrFn === 'function') initPropsOrFn(chosen);
        else if (initPropsOrFn && typeof initPropsOrFn === 'object') {
          Object.keys(initPropsOrFn).forEach(function(k) { chosen[k] = initPropsOrFn[k]; });
        }
        return chosen;
      },
      each: function(fn) {
        if (typeof fn !== 'function') return;
        for (var i = 0; i < items.length; i++) {
          if (items[i] && items[i].alive) fn(items[i], i);
        }
      },
      updateAll: function(dt) {
        for (var i = 0; i < items.length; i++) {
          var it = items[i];
          if (it && it.alive && typeof it.update === 'function') it.update(dt);
        }
      },
      drawAll: function() {
        for (var i = 0; i < items.length; i++) {
          var it = items[i];
          if (it && it.alive && typeof it.draw === 'function') it.draw();
        }
      },
      count: function() {
        var n = 0;
        for (var i = 0; i < items.length; i++) if (items[i] && items[i].alive) n++;
        return n;
      },
      clear: function() {
        for (var i = 0; i < items.length; i++) if (items[i]) items[i].alive = false;
      }
    };
    return pObj;
  }

  function fogOfWar(cols, rows, tileSize, opts) {
    var gc = Math.max(1, Math.floor(cols) || 20);
    var gr = Math.max(1, Math.floor(rows) || 15);
    var ts = Math.max(4, Number(tileSize) || 32);
    var o = isOptsObj(opts) ? opts : {};
    var fogColor = o.color || '#02050e';
    var stateArr = new Uint8Array(gc * gr);
    var off = document.createElement('canvas');
    off.width = gc * ts; off.height = gr * ts;
    var fctx = off.getContext('2d');
    var dirty = true;

    return {
      cols: gc, rows: gr, tileSize: ts,
      reveal: function(wxOrCx, wyOrCy, radCellsOrPx, gridMode) {
        var cx = gridMode === 'grid' ? wxOrCx : (wxOrCx / ts);
        var cy = gridMode === 'grid' ? wyOrCy : (wyOrCy / ts);
        var rc = radCellsOrPx > 25 && gridMode !== 'grid' ? (radCellsOrPx / ts) : (Number(radCellsOrPx) || 5);
        for (var i = 0; i < stateArr.length; i++) { if (stateArr[i] === 2) stateArr[i] = 1; }
        var x0 = Math.max(0, Math.floor(cx - rc - 1)), x1 = Math.min(gc - 1, Math.ceil(cx + rc + 1));
        var y0 = Math.max(0, Math.floor(cy - rc - 1)), y1 = Math.min(gr - 1, Math.ceil(cy + rc + 1));
        for (var yy = y0; yy <= y1; yy++) {
          for (var xx = x0; xx <= x1; xx++) {
            if (Math.hypot(xx + 0.5 - cx, yy + 0.5 - cy) <= rc + 0.35) {
              stateArr[yy * gc + xx] = 2;
            }
          }
        }
        dirty = true;
      },
      isVisible: function(gx, gy) {
        var ix = Math.floor(gx), iy = Math.floor(gy);
        if (ix < 0 || ix >= gc || iy < 0 || iy >= gr) return false;
        return stateArr[iy * gc + ix] === 2;
      },
      isExplored: function(gx, gy) {
        var ix = Math.floor(gx), iy = Math.floor(gy);
        if (ix < 0 || ix >= gc || iy < 0 || iy >= gr) return false;
        return stateArr[iy * gc + ix] >= 1;
      },
      resetVisible: function() {
        for (var i = 0; i < stateArr.length; i++) { if (stateArr[i] === 2) stateArr[i] = 1; }
        dirty = true;
      },
      clear: function() { stateArr.fill(0); dirty = true; },
      draw: function(alphaUnseen, alphaExplored) {
        var a0 = alphaUnseen === undefined ? 0.92 : Number(alphaUnseen);
        var a1 = alphaExplored === undefined ? 0.48 : Number(alphaExplored);
        if (dirty) {
          dirty = false;
          fctx.clearRect(0, 0, off.width, off.height);
          for (var y = 0; y < gr; y++) {
            for (var x = 0; x < gc; x++) {
              var v = stateArr[y * gc + x];
              if (v === 2) continue;
              fctx.globalAlpha = v === 0 ? a0 : a1;
              fctx.fillStyle = fogColor;
              fctx.fillRect(x * ts, y * ts, ts + 0.5, ts + 0.5);
            }
          }
        }
        ctx.drawImage(off, 0, 0);
      }
    };
  }

  function ragdoll(x, y, opts) {
    var o = isOptsObj(opts) ? opts : {};
    var sc = Number(o.scale) || 1;
    var grav = o.gravity !== undefined ? Number(o.gravity) : 720;
    var damp = o.damping !== undefined ? Number(o.damping) : 0.985;
    var col = o.color || '#38bdf8';
    var headCol = o.headColor || '#f8fafc';
    function pt(px, py) { return { x: px, y: py, ox: px, oy: py }; }
    // Nodes: 0:head, 1:neck, 2:hip, 3:handL, 4:handR, 5:footL, 6:footR
    var pts = [
      pt(x, y - 22 * sc),
      pt(x, y - 8 * sc),
      pt(x, y + 14 * sc),
      pt(x - 16 * sc, y + 4 * sc),
      pt(x + 16 * sc, y + 4 * sc),
      pt(x - 10 * sc, y + 36 * sc),
      pt(x + 10 * sc, y + 36 * sc)
    ];
    var links = [
      [0, 1, 14 * sc], [1, 2, 22 * sc],
      [1, 3, 20 * sc], [1, 4, 20 * sc],
      [2, 5, 24 * sc], [2, 6, 24 * sc],
      [0, 2, 34 * sc]
    ];
    return {
      points: pts, alive: true,
      impulse: function(vx, vy) {
        var dx = (Number(vx) || 0) * 0.016, dy = (Number(vy) || 0) * 0.016;
        for (var i = 0; i < pts.length; i++) { pts[i].ox -= dx; pts[i].oy -= dy; }
      },
      update: function(dt, floorYOrObs) {
        var step = Math.min(0.033, Math.max(0.001, Number(dt) || 0.016));
        for (var i = 0; i < pts.length; i++) {
          var p = pts[i];
          var vx = (p.x - p.ox) * damp;
          var vy = (p.y - p.oy) * damp;
          p.ox = p.x; p.oy = p.y;
          p.x += vx;
          p.y += vy + grav * step * step;
        }
        var fy = typeof floorYOrObs === 'number' ? floorYOrObs : (o.floorY !== undefined ? Number(o.floorY) : H - 6);
        for (var it = 0; it < 5; it++) {
          for (var li = 0; li < links.length; li++) {
            var a = pts[links[li][0]], b = pts[links[li][1]], len0 = links[li][2];
            var dx = b.x - a.x, dy = b.y - a.y;
            var d = Math.hypot(dx, dy) || 0.001;
            var diff = (d - len0) / d * 0.5;
            a.x += dx * diff; a.y += dy * diff;
            b.x -= dx * diff; b.y -= dy * diff;
          }
          for (var pi = 0; pi < pts.length; pi++) {
            var q = pts[pi];
            if (q.y > fy) { q.y = fy; q.ox += (q.x - q.ox) * 0.25; }
            if (q.x < 4) q.x = 4; else if (q.x > W * 4) q.x = W * 4;
          }
        }
      },
      draw: function(dOpts) {
        var lw = (dOpts && dOpts.lw) || (3.5 * sc);
        var c = (dOpts && dOpts.color) || col;
        for (var li = 0; li < 6; li++) {
          var a = pts[links[li][0]], b = pts[links[li][1]];
          drawLine(a.x, a.y, b.x, b.y, c, lw);
        }
        drawCircle(pts[0].x, pts[0].y, 7 * sc, headCol);
        strokeCircle(pts[0].x, pts[0].y, 7 * sc, c, 2);
      }
    };
  }

  function vec(x, y) {
    return {
      x: Number(x) || 0, y: Number(y) || 0,
      add: function(v) { return vec(this.x + v.x, this.y + v.y); },
      sub: function(v) { return vec(this.x - v.x, this.y - v.y); },
      mul: function(s) { return vec(this.x * s, this.y * s); },
      len: function() { return Math.hypot(this.x, this.y); },
      dot: function(v) { return this.x * v.x + this.y * v.y; },
      dist: function(v) { return Math.hypot(v.x - this.x, v.y - this.y); },
      angle: function() { return Math.atan2(this.y, this.x); },
      norm: function() { var l = Math.hypot(this.x, this.y) || 1; return vec(this.x / l, this.y / l); },
      clone: function() { return vec(this.x, this.y); }
    };
  }

  function BaseEntity(tagName) {
    this._shape = 'rect';
    this.tag = tagName || 'Entity';
    this.x = 0; this.y = 0; this.w = 32; this.h = 32; this.r = 16;
    this.vx = 0; this.vy = 0; this.rot = 0; this.scale = 1; this.alpha = 1;
    this.color = '#38bdf8';
    this.alive = true;
    this.state = '';
    this.stateTime = 0;
    this._states = null;
    this._scene = null;
  }
  BaseEntity.prototype.move = function(dx, dy) { this.x += dx || 0; this.y += dy || 0; };
  BaseEntity.prototype.destroy = function() { this.alive = false; };
  BaseEntity.prototype.collides = function(other) { return collides(this, other); };
  BaseEntity.prototype.distTo = function(other) { return other ? Math.hypot((other.x || 0) - this.x, (other.y || 0) - this.y) : Infinity; };
  BaseEntity.prototype.contains = function(px, py) {
    if (this._shape === 'circle') { var dx = px - this.x, dy = py - this.y; return dx * dx + dy * dy <= (this.r || 16) * (this.r || 16); }
    return px >= this.x && px <= this.x + (this.w || 32) && py >= this.y && py <= this.y + (this.h || 32);
  };
  BaseEntity.prototype.setState = function(nextName) {
    var args = [this, nextName];
    for (var i = 1; i < arguments.length; i++) args.push(arguments[i]);
    return setStateGlobal.apply(null, args);
  };
  BaseEntity.prototype.draw = function() {
    if (this._states && this.state && this._states[this.state] && typeof this._states[this.state].draw === 'function') {
      this._states[this.state].draw();
      return;
    }
    ctx.save();
    if (this.alpha !== undefined && this.alpha !== 1) ctx.globalAlpha *= Math.max(0, Math.min(1, this.alpha));
    if (this._shape === 'circle') drawCircle(this.x, this.y, this.r || 16, this.color || '#fbbf24');
    else drawRect(this.x, this.y, this.w || 32, this.h || 32, this.color || '#38bdf8');
    ctx.restore();
  };

  function setStateGlobal(ent, nextName) {
    if (!ent || typeof ent !== 'object') return ent;
    var nxt = String(nextName || '');
    var args = Array.prototype.slice.call(arguments, 2);
    var old = ent.state || '';
    if (old && ent._states && ent._states[old] && typeof ent._states[old].exit === 'function') {
      try { Promise.resolve(ent._states[old].exit()).catch(handleHookError); } catch(e) { handleHookError(e); }
    }
    ent.state = nxt;
    ent.stateTime = 0;
    if (nxt && ent._states && ent._states[nxt] && typeof ent._states[nxt].enter === 'function') {
      try { Promise.resolve(ent._states[nxt].enter.apply(null, args)).catch(handleHookError); } catch(e) { handleHookError(e); }
    }
    return ent;
  }

  function makeRectEntity(x, y, w, h, color) {
    var obj = {
      _shape: 'rect', tag: 'rect',
      x: Number(x) || 0, y: Number(y) || 0,
      w: Number(w) || 32, h: Number(h) || 32,
      vx: 0, vy: 0, rot: 0, scale: 1, alpha: 1,
      color: color || '#38bdf8', alive: true,
      draw: function() { drawRect(obj.x, obj.y, obj.w, obj.h, obj.color); },
      move: function(dx, dy) { obj.x += dx || 0; obj.y += dy || 0; },
      destroy: function() { obj.alive = false; },
      collides: function(other) { return collides(obj, other); },
      distTo: function(other) { return other ? Math.hypot((other.x || 0) - obj.x, (other.y || 0) - obj.y) : Infinity; },
      contains: function(px, py) { return px >= obj.x && px <= obj.x + obj.w && py >= obj.y && py <= obj.y + obj.h; }
    };
    if (inDraw) obj.draw();
    return obj;
  }

  function makeCircleEntity(x, y, r, color) {
    var obj = {
      _shape: 'circle', tag: 'circle',
      x: Number(x) || 0, y: Number(y) || 0,
      r: Number(r) || 16,
      vx: 0, vy: 0, rot: 0, scale: 1, alpha: 1,
      color: color || '#fbbf24', alive: true,
      draw: function() { drawCircle(obj.x, obj.y, obj.r, obj.color); },
      move: function(dx, dy) { obj.x += dx || 0; obj.y += dy || 0; },
      destroy: function() { obj.alive = false; },
      collides: function(other) { return collides(obj, other); },
      distTo: function(other) { return other ? Math.hypot((other.x || 0) - obj.x, (other.y || 0) - obj.y) : Infinity; },
      contains: function(px, py) { var dx = px - obj.x, dy = py - obj.y; return dx * dx + dy * dy <= obj.r * obj.r; }
    };
    if (inDraw) obj.draw();
    return obj;
  }

  // --- Procedural Noise, Colors, Circle Physics, Spatial Query ---
  function hash2d(ix, iy, seed) {
    var h = (ix * 374761393 + iy * 668265263 + (seed || 0) * 1442695041) | 0;
    h = (h ^ (h >> 13)) * 1274126177;
    return ((h ^ (h >> 16)) >>> 0) / 4294967295;
  }
  function smoothFade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
  function noise2d(x, y, seed) {
    var fx = Number(x) || 0, fy = Number(y) || 0, sd = Math.floor(Number(seed) || 0);
    var x0 = Math.floor(fx), y0 = Math.floor(fy);
    var dx = fx - x0, dy = fy - y0;
    var u = smoothFade(dx), v = smoothFade(dy);
    var n00 = hash2d(x0, y0, sd), n10 = hash2d(x0 + 1, y0, sd);
    var n01 = hash2d(x0, y0 + 1, sd), n11 = hash2d(x0 + 1, y0 + 1, sd);
    var nx0 = n00 + (n10 - n00) * u;
    var nx1 = n01 + (n11 - n01) * u;
    return (nx0 + (nx1 - nx0) * v) * 2 - 1;
  }
  function fbm(x, y, octaves, seed) {
    var oct = Math.max(1, Math.min(8, Math.floor(Number(octaves) || 4)));
    var amp = 0.5, freq = 1, sum = 0, norm = 0;
    for (var i = 0; i < oct; i++) {
      sum += amp * noise2d((Number(x) || 0) * freq, (Number(y) || 0) * freq, (Number(seed) || 0) + i * 101);
      norm += amp; amp *= 0.5; freq *= 2;
    }
    return norm > 0 ? sum / norm : 0;
  }
  function hsl(h, s, l, a) {
    var hh = Math.round(Number(h) || 0);
    var ss = Math.max(0, Math.min(100, s === undefined ? 80 : Number(s)));
    var ll = Math.max(0, Math.min(100, l === undefined ? 55 : Number(l)));
    if (a !== undefined && a !== null && Number(a) < 1) {
      return 'hsla(' + hh + ',' + ss + '%,' + ll + '%,' + Math.max(0, Math.min(1, Number(a))) + ')';
    }
    return 'hsl(' + hh + ',' + ss + '%,' + ll + '%)';
  }
  var _colorCache = {};
  function parseColorRgba(c) {
    var key = String(c || '#ffffff').trim();
    if (_colorCache[key]) return _colorCache[key];
    var r = 255, g = 255, b = 255, a = 1;
    if (key[0] === '#') {
      var hx = key.slice(1);
      if (hx.length === 3 || hx.length === 4) {
        r = parseInt(hx[0] + hx[0], 16) || 0;
        g = parseInt(hx[1] + hx[1], 16) || 0;
        b = parseInt(hx[2] + hx[2], 16) || 0;
        if (hx.length === 4) a = (parseInt(hx[3] + hx[3], 16) || 255) / 255;
      } else if (hx.length >= 6) {
        r = parseInt(hx.slice(0, 2), 16) || 0;
        g = parseInt(hx.slice(2, 4), 16) || 0;
        b = parseInt(hx.slice(4, 6), 16) || 0;
        if (hx.length === 8) a = (parseInt(hx.slice(6, 8), 16) || 255) / 255;
      }
    } else {
      var m = /^rgba?\\(([^)]+)\\)$/i.exec(key);
      if (m) {
        var ps = m[1].split(',');
        r = Number(ps[0]) || 0; g = Number(ps[1]) || 0; b = Number(ps[2]) || 0;
        if (ps[3] !== undefined) a = Number(ps[3]);
      } else {
        var mH = /^hsla?\\(([^)]+)\\)$/i.exec(key);
        if (mH) {
          var hp = mH[1].split(',');
          var H0 = ((Number(hp[0]) % 360) + 360) % 360 / 360;
          var S0 = (parseFloat(hp[1]) || 0) / 100;
          var L0 = (parseFloat(hp[2]) || 0) / 100;
          if (hp[3] !== undefined) a = Number(hp[3]);
          var q0 = L0 < 0.5 ? L0 * (1 + S0) : L0 + S0 - L0 * S0;
          var p0 = 2 * L0 - q0;
          var h2r = function(t) {
            if (t < 0) t += 1; if (t > 1) t -= 1;
            if (t < 1/6) return p0 + (q0 - p0) * 6 * t;
            if (t < 0.5) return q0;
            if (t < 2/3) return p0 + (q0 - p0) * (2/3 - t) * 6;
            return p0;
          };
          r = Math.round(h2r(H0 + 1/3) * 255);
          g = Math.round(h2r(H0) * 255);
          b = Math.round(h2r(H0 - 1/3) * 255);
        }
      }
    }
    var res = [r | 0, g | 0, b | 0, Math.max(0, Math.min(1, a))];
    if (Object.keys(_colorCache).length < 512) _colorCache[key] = res;
    return res;
  }
  function lerpColor(c1, c2, t) {
    var k = Math.max(0, Math.min(1, Number(t) || 0));
    var a = parseColorRgba(c1), b = parseColorRgba(c2);
    var r = Math.round(a[0] + (b[0] - a[0]) * k);
    var g = Math.round(a[1] + (b[1] - a[1]) * k);
    var bl = Math.round(a[2] + (b[2] - a[2]) * k);
    var al = a[3] + (b[3] - a[3]) * k;
    return al < 0.999 ? ('rgba(' + r + ',' + g + ',' + bl + ',' + al.toFixed(3) + ')') : ('rgb(' + r + ',' + g + ',' + bl + ')');
  }

  function bounceCircle(ent, obstacles, elasticity, radiusOverride) {
    if (!ent) return { hit: false, nx: 0, ny: 0 };
    var rad = Number(radiusOverride || ent.r || (ent.w ? ent.w * 0.5 : 16)) || 16;
    var el = elasticity === undefined ? 0.85 : Number(elasticity);
    var list = !obstacles ? [] : (Array.isArray(obstacles) ? obstacles : [obstacles]);
    var hit = false, lnx = 0, lny = 0;
    function resolveBox(bx, by, bw, bh) {
      var cx = Math.max(bx, Math.min(bx + bw, ent.x));
      var cy = Math.max(by, Math.min(by + bh, ent.y));
      var dx = ent.x - cx, dy = ent.y - cy;
      var d2 = dx * dx + dy * dy;
      if (d2 >= rad * rad) return;
      hit = true;
      var nx = 0, ny = 0, pen = 0;
      if (d2 > 0.00001) {
        var d = Math.sqrt(d2);
        nx = dx / d; ny = dy / d; pen = rad - d;
      } else {
        var dl = Math.abs(ent.x - bx), dr = Math.abs(bx + bw - ent.x);
        var dt = Math.abs(ent.y - by), db = Math.abs(by + bh - ent.y);
        var m = Math.min(dl, dr, dt, db);
        if (m === dl) { nx = -1; pen = rad + dl; }
        else if (m === dr) { nx = 1; pen = rad + dr; }
        else if (m === dt) { ny = -1; pen = rad + dt; }
        else { ny = 1; pen = rad + db; }
      }
      ent.x += nx * pen;
      ent.y += ny * pen;
      var vn = (ent.vx || 0) * nx + (ent.vy || 0) * ny;
      if (vn < 0) {
        ent.vx = (ent.vx || 0) - (1 + el) * vn * nx;
        ent.vy = (ent.vy || 0) - (1 + el) * vn * ny;
      }
      lnx = nx; lny = ny;
    }
    for (var i = 0; i < list.length; i++) {
      var ob = list[i];
      if (!ob || ob === ent || ob.alive === false) continue;
      if (ob._isTilemap) {
        var ts = ob.tileSize;
        var x0 = Math.floor((ent.x - rad) / ts), y0 = Math.floor((ent.y - rad) / ts);
        var x1 = Math.floor((ent.x + rad) / ts), y1 = Math.floor((ent.y + rad) / ts);
        for (var gy = y0; gy <= y1; gy++) {
          if (gy < 0 || gy >= ob.rows) continue;
          for (var gx = x0; gx <= x1; gx++) {
            if (gx < 0 || gx >= ob.cols) continue;
            if (ob._isSolidChar(ob.get(gx, gy))) resolveBox(gx * ts, gy * ts, ts, ts);
          }
        }
      } else if (ob._shape === 'circle') {
        var r2 = Number(ob.r) || 16;
        var dx = ent.x - ob.x, dy = ent.y - ob.y;
        var d2 = dx * dx + dy * dy, minR = rad + r2;
        if (d2 < minR * minR) {
          hit = true;
          var d = Math.sqrt(d2) || 0.001;
          var nx = dx / d, ny = dy / d;
          ent.x += nx * (minR - d); ent.y += ny * (minR - d);
          var vn = (ent.vx || 0) * nx + (ent.vy || 0) * ny;
          if (vn < 0) {
            ent.vx = (ent.vx || 0) - (1 + el) * vn * nx;
            ent.vy = (ent.vy || 0) - (1 + el) * vn * ny;
          }
          lnx = nx; lny = ny;
        }
      } else {
        resolveBox(Number(ob.x) || 0, Number(ob.y) || 0, Number(ob.w) || 0, Number(ob.h) || 0);
      }
    }
    return { hit: hit, nx: lnx, ny: lny };
  }

  function spatialQuery(entitiesList, x, y, radius) {
    var list = Array.isArray(entitiesList) ? entitiesList : worldEntities;
    var qx = Number(x) || 0, qy = Number(y) || 0, r2 = (Number(radius) || 64);
    r2 = r2 * r2;
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (!e || e.alive === false) continue;
      var ex = e._shape === 'circle' ? e.x : (e.x + (e.w || 0) * 0.5);
      var ey = e._shape === 'circle' ? e.y : (e.y + (e.h || 0) * 0.5);
      var dx = ex - qx, dy = ey - qy;
      if (dx * dx + dy * dy <= r2) out.push(e);
    }
    return out;
  }

  function limitSteering(fx, fy, maxF) {
    var l = Math.hypot(fx, fy);
    if (maxF > 0 && l > maxF) { var s = maxF / l; return { x: fx * s, y: fy * s }; }
    return { x: fx, y: fy };
  }
  function steerSeek(ent, tx, ty, speed, maxForce) {
    if (!ent) return { x: 0, y: 0 };
    var spd = Number(speed) || 160;
    var dx = (Number(tx) || 0) - ent.x, dy = (Number(ty) || 0) - ent.y;
    var d = Math.hypot(dx, dy);
    if (d < 0.001) return { x: -(ent.vx || 0), y: -(ent.vy || 0) };
    var dvx = (dx / d) * spd - (ent.vx || 0);
    var dvy = (dy / d) * spd - (ent.vy || 0);
    return limitSteering(dvx, dvy, maxForce === undefined ? spd * 4 : Number(maxForce));
  }
  function steerArrive(ent, tx, ty, speed, slowRadius, maxForce) {
    if (!ent) return { x: 0, y: 0 };
    var spd = Number(speed) || 160, sr = Math.max(8, Number(slowRadius) || 90);
    var dx = (Number(tx) || 0) - ent.x, dy = (Number(ty) || 0) - ent.y;
    var d = Math.hypot(dx, dy);
    if (d < 0.001) return { x: -(ent.vx || 0), y: -(ent.vy || 0) };
    var desiredSpd = d < sr ? spd * (d / sr) : spd;
    var dvx = (dx / d) * desiredSpd - (ent.vx || 0);
    var dvy = (dy / d) * desiredSpd - (ent.vy || 0);
    return limitSteering(dvx, dvy, maxForce === undefined ? spd * 4 : Number(maxForce));
  }
  function steerSeparate(entitiesList, ent, radius, force) {
    if (!ent || !Array.isArray(entitiesList)) return { x: 0, y: 0 };
    var rad = Math.max(4, Number(radius) || 40);
    var f = Number(force) || 180;
    var sx = 0, sy = 0, count = 0;
    for (var i = 0; i < entitiesList.length; i++) {
      var o = entitiesList[i];
      if (!o || o === ent || o.alive === false) continue;
      var dx = ent.x - o.x, dy = ent.y - o.y;
      var d = Math.hypot(dx, dy);
      if (d > 0.001 && d < rad) {
        var w = (rad - d) / rad;
        sx += (dx / d) * w;
        sy += (dy / d) * w;
        count++;
      }
    }
    if (count > 0) {
      var l = Math.hypot(sx, sy) || 1;
      return { x: (sx / l) * f, y: (sy / l) * f };
    }
    return { x: 0, y: 0 };
  }

  // --- Pre-allocated Float32Array 5,000 Particle Pool ---
  var MAX_PARTICLES = 5000;
  var pCount = 0;
  var pX = new Float32Array(MAX_PARTICLES), pY = new Float32Array(MAX_PARTICLES);
  var pVx = new Float32Array(MAX_PARTICLES), pVy = new Float32Array(MAX_PARTICLES);
  var pLife = new Float32Array(MAX_PARTICLES), pMaxLife = new Float32Array(MAX_PARTICLES);
  var pSz0 = new Float32Array(MAX_PARTICLES), pSz1 = new Float32Array(MAX_PARTICLES);
  var pGrav = new Float32Array(MAX_PARTICLES), pDrag = new Float32Array(MAX_PARTICLES);
  var pR0 = new Uint8Array(MAX_PARTICLES), pG0 = new Uint8Array(MAX_PARTICLES), pB0 = new Uint8Array(MAX_PARTICLES);
  var pR1 = new Uint8Array(MAX_PARTICLES), pG1 = new Uint8Array(MAX_PARTICLES), pB1 = new Uint8Array(MAX_PARTICLES);
  var pBlend = new Uint8Array(MAX_PARTICLES);

  function spawnParticles(x, y, color, count, speedMax) {
    var o = isOptsObj(x) ? x : (isOptsObj(color) ? color : null);
    var px0 = Number(o && x === o ? o.x : x) || 0;
    var py0 = Number(o && x === o ? o.y : y) || 0;
    var n = Math.min(1000, Number(o ? (o.count !== undefined ? o.count : 12) : count) || 12);
    var sMin = o && o.speedMin !== undefined ? Number(o.speedMin) : 40;
    var sMax = o ? Number(o.speedMax !== undefined ? o.speedMax : (o.speed !== undefined ? o.speed : 180)) : (Number(speedMax) || 180);
    if (sMax < sMin) sMin = sMax * 0.25;
    var baseAng = o && o.angle !== undefined ? Number(o.angle) : 0;
    var spread = o && o.spread !== undefined ? Number(o.spread) : Math.PI * 2;
    var grav = o && o.gravity !== undefined ? Number(o.gravity) : 0;
    var drag = o && o.drag !== undefined ? Number(o.drag) : 0;
    var szA = o && o.size !== undefined ? Number(o.size) : 4.5;
    var szB = o && o.sizeEnd !== undefined ? Number(o.sizeEnd) : szA * 0.35;
    var lMin = o && o.life !== undefined ? Number(o.life) * 0.75 : 0.35;
    var lMax = o && o.life !== undefined ? Number(o.life) * 1.25 : 0.8;
    var cA = parseColorRgba((o ? o.color : color) || '#fbbf24');
    var cB = (o && o.colorEnd) ? parseColorRgba(o.colorEnd) : cA;
    var isAdd = (o && (o.blend === 'lighter' || o.blend === 'add')) ? 1 : 0;
    for (var i = 0; i < n; i++) {
      if (pCount >= MAX_PARTICLES) break;
      var idx = pCount++;
      var ang = spread >= Math.PI * 1.99 ? Math.random() * Math.PI * 2 : (baseAng + (Math.random() - 0.5) * spread);
      var spd = sMin + Math.random() * (sMax - sMin);
      var lf = Math.max(0.05, lMin + Math.random() * (lMax - lMin));
      pX[idx] = px0; pY[idx] = py0;
      pVx[idx] = Math.cos(ang) * spd; pVy[idx] = Math.sin(ang) * spd;
      pLife[idx] = lf; pMaxLife[idx] = lf;
      pSz0[idx] = o && o.size !== undefined ? szA : (2 + Math.random() * 3.5);
      pSz1[idx] = o && o.sizeEnd !== undefined ? szB : pSz0[idx] * 0.4;
      pGrav[idx] = grav; pDrag[idx] = drag;
      pR0[idx] = cA[0]; pG0[idx] = cA[1]; pB0[idx] = cA[2];
      pR1[idx] = cB[0]; pG1[idx] = cB[1]; pB1[idx] = cB[2];
      pBlend[idx] = isAdd;
    }
  }

  // --- 2D Lighting, Directional Cone Lights & Raycast Shadows (Half-Res Lightmap) ---
  var lightCanvas = document.createElement('canvas');
  var lightCtx = lightCanvas.getContext('2d');
  var lightState = { hasAmbient: false, ambientCol: '#020617', darkness: 0.72, lights: [], casters: [] };

  function ambientLight(color, darkness) {
    if (typeof color === 'number') {
      lightState.hasAmbient = true;
      lightState.ambientCol = '#020617';
      lightState.darkness = Math.max(0, Math.min(1, color));
    } else {
      lightState.hasAmbient = true;
      lightState.ambientCol = color || '#020617';
      lightState.darkness = darkness === undefined ? 0.75 : Math.max(0, Math.min(1, Number(darkness)));
    }
  }
  function pushLightEntry(kind, x, y, radius, color, optsOrIntensity) {
    var o = isOptsObj(color) ? color : (isOptsObj(optsOrIntensity) ? optsOrIntensity : null);
    var col = o ? (o.color || '#ffffff') : (color || '#ffffff');
    var inten = o ? (o.intensity !== undefined ? Number(o.intensity) : 1) : (optsOrIntensity === undefined ? 1 : Number(optsOrIntensity));
    lightState.lights.push({
      kind: kind,
      x: Number(x) || 0, y: Number(y) || 0,
      r: Math.max(8, Number(radius) || 140),
      color: col,
      intensity: inten,
      flicker: o ? Math.max(0, Math.min(0.8, Number(o.flicker) || 0)) : 0,
      angle: o && o.angle !== undefined ? Number(o.angle) : undefined,
      spread: o && o.spread !== undefined ? Number(o.spread) : undefined,
      castShadow: kind === 'shadow' || (o && o.shadow !== false)
    });
  }
  function light(x, y, radius, color, intensity) {
    pushLightEntry('radial', x, y, radius, color, intensity);
  }
  function shadowLight(x, y, radius, color, intensity) {
    pushLightEntry('shadow', x, y, radius, color || '#fde68a', intensity);
  }
  function coneLight(x, y, radius, angle, spread, color, optsOrIntensity) {
    var o = isOptsObj(color) ? color : (isOptsObj(optsOrIntensity) ? optsOrIntensity : {});
    var col = isOptsObj(color) ? (o.color || '#fde68a') : (color || '#fde68a');
    var inten = isOptsObj(optsOrIntensity) ? (o.intensity !== undefined ? Number(o.intensity) : 1) : (optsOrIntensity === undefined ? 1 : Number(optsOrIntensity));
    lightState.lights.push({
      kind: (o.shadow === false ? 'radial' : 'shadow'),
      x: Number(x) || 0, y: Number(y) || 0,
      r: Math.max(8, Number(radius) || 260),
      color: col,
      intensity: inten,
      flicker: Math.max(0, Math.min(0.8, Number(o.flicker) || 0)),
      angle: Number(angle) || 0,
      spread: Math.max(0.05, Math.min(Math.PI * 2, spread === undefined ? Math.PI * 0.35 : Number(spread))),
      castShadow: o.shadow !== false
    });
  }
  function shadowCasters(obstacles) {
    var segs = [];
    var list = !obstacles ? [] : (Array.isArray(obstacles) ? obstacles : [obstacles]);
    function addRectSegs(rx, ry, rw, rh) {
      segs.push([rx, ry, rx + rw, ry], [rx + rw, ry, rx + rw, ry + rh], [rx + rw, ry + rh, rx, ry + rh], [rx, ry + rh, rx, ry]);
    }
    for (var i = 0; i < list.length; i++) {
      var ob = list[i];
      if (!ob || ob.alive === false) continue;
      if (ob._isTilemap) {
        var ts = ob.tileSize;
        for (var gy = 0; gy < ob.rows; gy++) {
          for (var gx = 0; gx < ob.cols; gx++) {
            if (!ob._isSolidChar(ob.get(gx, gy))) continue;
            var rx = gx * ts, ry = gy * ts;
            if (gy === 0 || !ob._isSolidChar(ob.get(gx, gy - 1))) segs.push([rx, ry, rx + ts, ry]);
            if (gx + 1 >= ob.cols || !ob._isSolidChar(ob.get(gx + 1, gy))) segs.push([rx + ts, ry, rx + ts, ry + ts]);
            if (gy + 1 >= ob.rows || !ob._isSolidChar(ob.get(gx, gy + 1))) segs.push([rx + ts, ry + ts, rx, ry + ts]);
            if (gx === 0 || !ob._isSolidChar(ob.get(gx - 1, gy))) segs.push([rx, ry + ts, rx, ry]);
          }
        }
      } else if (Array.isArray(ob) && ob.length === 4) {
        segs.push(ob);
      } else if (ob.x1 !== undefined && ob.y2 !== undefined) {
        segs.push([ob.x1, ob.y1, ob.x2, ob.y2]);
      } else {
        var bx = ob._shape === 'circle' ? ob.x - ob.r : (Number(ob.x) || 0);
        var by = ob._shape === 'circle' ? ob.y - ob.r : (Number(ob.y) || 0);
        var bw = ob._shape === 'circle' ? ob.r * 2 : (Number(ob.w) || 0);
        var bh = ob._shape === 'circle' ? ob.r * 2 : (Number(ob.h) || 0);
        if (bw > 0 && bh > 0) addRectSegs(bx, by, bw, bh);
      }
    }
    lightState.casters = segs;
  }

  function renderLightOverlayToWorld(shakeOx, shakeOy) {
    if (!lightState.hasAmbient && lightState.lights.length === 0) return;
    var lw = Math.max(1, Math.round(W * 0.5)), lh = Math.max(1, Math.round(H * 0.5));
    if (lightCanvas.width !== lw || lightCanvas.height !== lh) {
      lightCanvas.width = lw; lightCanvas.height = lh;
    }
    lightCtx.save();
    lightCtx.setTransform(1, 0, 0, 1, 0, 0);
    if (lightState.hasAmbient) {
      var ac = parseColorRgba(lightState.ambientCol);
      var d = lightState.darkness;
      var ar = Math.round(255 + (ac[0] - 255) * d);
      var ag = Math.round(255 + (ac[1] - 255) * d);
      var ab = Math.round(255 + (ac[2] - 255) * d);
      lightCtx.fillStyle = 'rgb(' + ar + ',' + ag + ',' + ab + ')';
      lightCtx.fillRect(0, 0, lw, lh);
    } else {
      lightCtx.clearRect(0, 0, lw, lh);
    }
    lightCtx.scale(0.5, 0.5);
    if (frameCamTransform.active) {
      lightCtx.translate(W / 2 + shakeOx, H / 2 + shakeOy);
      lightCtx.scale(cam.zoom, cam.zoom);
      lightCtx.translate(-W / 2 - cam.x, -H / 2 - cam.y);
    }
    lightCtx.globalCompositeOperation = 'lighter';
    for (var li = 0; li < lightState.lights.length; li++) {
      var L = lightState.lights[li];
      var lc = parseColorRgba(L.color);
      var flk = L.flicker > 0 ? (1 + (Math.sin(gameTime * 13.7 + L.x * 0.11 + L.y * 0.07) * 0.6 + Math.cos(gameTime * 27.3 + L.y * 0.17) * 0.4) * L.flicker) : 1;
      var radEff = L.r * (L.flicker > 0 ? (1 + (flk - 1) * 0.3) : 1);
      var inten = Math.max(0, Math.min(2, L.intensity * flk));
      var rC = Math.min(255, Math.round(lc[0] * inten));
      var gC = Math.min(255, Math.round(lc[1] * inten));
      var bC = Math.min(255, Math.round(lc[2] * inten));
      lightCtx.save();
      if (L.kind === 'shadow' && lightState.casters.length > 0) {
        var near = [], angles = [];
        var rPad = radEff * 1.45;
        for (var si = 0; si < lightState.casters.length; si++) {
          var sg = lightState.casters[si];
          if ((sg[0] < L.x - rPad && sg[2] < L.x - rPad) || (sg[0] > L.x + rPad && sg[2] > L.x + rPad) ||
              (sg[1] < L.y - rPad && sg[3] < L.y - rPad) || (sg[1] > L.y + rPad && sg[3] > L.y + rPad)) continue;
          near.push(sg);
          var a1 = Math.atan2(sg[1] - L.y, sg[0] - L.x);
          var a2 = Math.atan2(sg[3] - L.y, sg[2] - L.x);
          angles.push(a1 - 0.0003, a1, a1 + 0.0003, a2 - 0.0003, a2, a2 + 0.0003);
        }
        for (var ba = 0; ba < 16; ba++) angles.push(-Math.PI + (ba * Math.PI * 2) / 16);
        angles.sort(function(a, b) { return a - b; });
        lightCtx.beginPath();
        for (var ai = 0; ai < angles.length; ai++) {
          var ang = angles[ai];
          var rdx = Math.cos(ang), rdy = Math.sin(ang);
          var bestT = radEff;
          for (var nj = 0; nj < near.length; nj++) {
            var s = near[nj];
            var sdx = s[2] - s[0], sdy = s[3] - s[1];
            var denom = rdx * sdy - rdy * sdx;
            if (Math.abs(denom) < 1e-7) continue;
            var qpx = s[0] - L.x, qpy = s[1] - L.y;
            var tRay = (qpx * sdy - qpy * sdx) / denom;
            if (tRay < 0 || tRay >= bestT) continue;
            var uSeg = (qpx * rdy - qpy * rdx) / denom;
            if (uSeg >= 0 && uSeg <= 1) bestT = tRay;
          }
          var hx = L.x + rdx * bestT, hy = L.y + rdy * bestT;
          if (ai === 0) lightCtx.moveTo(hx, hy); else lightCtx.lineTo(hx, hy);
        }
        lightCtx.closePath();
        lightCtx.clip();
      }
      if (L.angle !== undefined && L.spread !== undefined && L.spread < Math.PI * 1.99) {
        lightCtx.beginPath();
        lightCtx.moveTo(L.x, L.y);
        lightCtx.arc(L.x, L.y, radEff, L.angle - L.spread * 0.5, L.angle + L.spread * 0.5);
        lightCtx.closePath();
        lightCtx.clip();
      }
      var grad = lightCtx.createRadialGradient(L.x, L.y, 0, L.x, L.y, radEff);
      grad.addColorStop(0, 'rgba(' + rC + ',' + gC + ',' + bC + ',' + Math.min(1, inten) + ')');
      grad.addColorStop(0.55, 'rgba(' + rC + ',' + gC + ',' + bC + ',' + (Math.min(1, inten) * 0.35) + ')');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      lightCtx.fillStyle = grad;
      lightCtx.beginPath();
      lightCtx.arc(L.x, L.y, radEff, 0, Math.PI * 2);
      lightCtx.fill();
      lightCtx.restore();
    }
    lightCtx.restore();

    worldCtx.save();
    worldCtx.setTransform(1, 0, 0, 1, 0, 0);
    if (lightState.hasAmbient) {
      worldCtx.globalCompositeOperation = 'multiply';
      worldCtx.drawImage(lightCanvas, 0, 0, lw, lh, 0, 0, worldCanvas.width, worldCanvas.height);
    } else {
      worldCtx.globalCompositeOperation = 'lighter';
      worldCtx.globalAlpha = 0.55;
      worldCtx.drawImage(lightCanvas, 0, 0, lw, lh, 0, 0, worldCanvas.width, worldCanvas.height);
    }
    worldCtx.restore();
    lightState.hasAmbient = false;
    lightState.lights.length = 0;
  }

  // --- Built-in Camera-Wrapped Weather System (Zero Allocation Float32Array Pool) ---
  var MAX_WEATHER = 800;
  var wPoolX = new Float32Array(MAX_WEATHER), wPoolY = new Float32Array(MAX_WEATHER);
  var wPoolSpd = new Float32Array(MAX_WEATHER), wPoolPh = new Float32Array(MAX_WEATHER);
  var weatherState = { type: '', intensity: 0, wind: 0, count: 0 };

  function weather(type, intensity, wind) {
    var t = !type || type === 'none' || type === 'off' ? '' : String(type).toLowerCase();
    var inten = intensity === undefined ? 0.65 : Math.max(0, Math.min(1.5, Number(intensity) || 0));
    var wnd = wind === undefined ? (t === 'rain' ? -80 : (t === 'snow' ? 28 : 18)) : Number(wind) || 0;
    var needInit = t && t !== weatherState.type;
    weatherState.type = t;
    weatherState.intensity = inten;
    weatherState.wind = wnd;
    if (!t || inten <= 0.01) { weatherState.count = 0; return; }
    var targetCnt = t === 'rain' ? Math.min(MAX_WEATHER, Math.round(380 * inten)) : Math.min(MAX_WEATHER, Math.round(160 * inten));
    if (needInit) {
      var z = cam.zoom || 1;
      var spanW = (W / z) * 1.35, spanH = (H / z) * 1.35;
      var x0 = cam.x + W * 0.5 - spanW * 0.5, y0 = cam.y + H * 0.5 - spanH * 0.5;
      for (var i = 0; i < MAX_WEATHER; i++) {
        wPoolX[i] = x0 + Math.random() * spanW;
        wPoolY[i] = y0 + Math.random() * spanH;
        wPoolSpd[i] = 0.75 + Math.random() * 0.55;
        wPoolPh[i] = Math.random() * Math.PI * 2;
      }
    }
    weatherState.count = targetCnt;
  }

  function updateAndDrawWeather(dt) {
    var n = weatherState.count, t = weatherState.type;
    if (n <= 0 || !t) return;
    var z = cam.zoom || 1;
    var padW = (W / z) * 1.3, padH = (H / z) * 1.3;
    var minX = cam.x + W * 0.5 - padW * 0.5, maxX = minX + padW;
    var minY = cam.y + H * 0.5 - padH * 0.5, maxY = minY + padH;
    var vyBase = t === 'rain' ? 680 : (t === 'snow' ? 68 : (t === 'embers' ? -72 : -18));
    var vxBase = weatherState.wind;
    ctx.save();
    for (var i = 0; i < n; i++) {
      var mul = wPoolSpd[i];
      var vx = vxBase * mul;
      if (t === 'snow' || t === 'spores' || t === 'embers') {
        vx += Math.sin(gameTime * 2.2 + wPoolPh[i]) * (t === 'spores' ? 22 : 16);
      }
      var vy = vyBase * mul;
      wPoolX[i] += vx * dt;
      wPoolY[i] += vy * dt;
      if (wPoolX[i] < minX) wPoolX[i] += padW;
      else if (wPoolX[i] > maxX) wPoolX[i] -= padW;
      if (wPoolY[i] < minY) wPoolY[i] += padH;
      else if (wPoolY[i] > maxY) wPoolY[i] -= padH;
      var px = wPoolX[i], py = wPoolY[i];
      if (t === 'rain') {
        ctx.strokeStyle = 'rgba(147,197,253,0.42)';
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px + vx * 0.028, py + vy * 0.028);
        ctx.stroke();
      } else if (t === 'snow') {
        var sr = 1.6 + (mul - 0.7) * 2.2;
        ctx.fillStyle = 'rgba(241,245,249,0.72)';
        ctx.beginPath();
        ctx.arc(px, py, sr, 0, Math.PI * 2);
        ctx.fill();
      } else if (t === 'embers') {
        var ea = 0.5 + 0.35 * Math.sin(gameTime * 7 + wPoolPh[i]);
        ctx.fillStyle = 'rgba(251,146,60,' + ea.toFixed(2) + ')';
        ctx.fillRect(px - 1.5, py - 1.5, 3, 3);
      } else {
        var sa = 0.35 + 0.3 * Math.sin(gameTime * 3 + wPoolPh[i]);
        ctx.fillStyle = 'rgba(167,243,208,' + sa.toFixed(2) + ')';
        ctx.beginPath();
        ctx.arc(px, py, 2.1, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  // --- v6.1 2D Water Zone with Live Vertical World Reflection & Ripples ---
  var waterReflCanvas = document.createElement('canvas');
  var waterReflCtx = waterReflCanvas.getContext('2d');
  function waterZone(x, y, w, h, opts) {
    var o = isOptsObj(x) ? x : (isOptsObj(opts) ? opts : {});
    var wx = isOptsObj(x) ? (Number(o.x) || 0) : (Number(x) || 0);
    var wy = isOptsObj(x) ? (Number(o.y) || 0) : (Number(y) || 0);
    var ww = Math.max(4, isOptsObj(x) ? (Number(o.w) || 200) : (Number(w) || 200));
    var wh = Math.max(4, isOptsObj(x) ? (Number(o.h) || 80) : (Number(h) || 80));
    var topCol = o.color || 'rgba(14, 116, 144, 0.42)';
    var deepCol = o.deepColor || 'rgba(8, 47, 73, 0.78)';
    var hiCol = o.highlight || 'rgba(186, 230, 253, 0.75)';
    var reflAlpha = o.reflection === false ? 0 : Math.max(0, Math.min(1, o.reflection === undefined ? 0.42 : Number(o.reflection)));
    var waveAmp = o.waveAmp === undefined ? 2.6 : Number(o.waveAmp);
    var waveFreq = o.waveFreq === undefined ? 0.16 : Number(o.waveFreq);
    var waveSpd = o.waveSpeed === undefined ? 3.8 : Number(o.waveSpeed);

    var tr = typeof ctx.getTransform === 'function' ? ctx.getTransform() : null;
    var scaleX = tr ? Math.abs(tr.a) : DPR;
    var scaleY = tr ? Math.abs(tr.d) : DPR;
    var sx = tr ? (tr.e + wx * tr.a) : (wx * DPR);
    var sy = tr ? (tr.f + wy * tr.d) : (wy * DPR);
    var sw = Math.max(1, Math.round(ww * scaleX));
    var sh = Math.max(1, Math.round(wh * scaleY));

    if (reflAlpha > 0 && ctx === worldCtx && sw > 2 && sh > 2 && worldCanvas.width > 0 && worldCanvas.height > 0) {
      var srcX = Math.max(0, Math.min(worldCanvas.width - 1, Math.round(sx)));
      var srcW = Math.max(1, Math.min(worldCanvas.width - srcX, sw));
      var reflH = Math.min(sh, Math.max(1, Math.round(sy)));
      var srcY = Math.max(0, Math.round(sy) - reflH);
      if (srcW > 1 && reflH > 2) {
        if (waterReflCanvas.width < srcW || waterReflCanvas.height < reflH) {
          waterReflCanvas.width = Math.max(waterReflCanvas.width, srcW);
          waterReflCanvas.height = Math.max(waterReflCanvas.height, reflH);
        }
        waterReflCtx.clearRect(0, 0, srcW, reflH);
        waterReflCtx.drawImage(worldCanvas, srcX, srcY, srcW, reflH, 0, 0, srcW, reflH);

        ctx.save();
        ctx.beginPath();
        ctx.rect(wx, wy, ww, wh);
        ctx.clip();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        var stripH = Math.max(2, Math.round(2 * DPR));
        for (var ry = 0; ry < reflH; ry += stripH) {
          var hStep = Math.min(stripH, reflH - ry);
          var srcRow = Math.max(0, reflH - ry - hStep);
          var prog = ry / reflH;
          var waveDx = Math.sin(gameTime * waveSpd + ry * (waveFreq / Math.max(0.5, scaleY))) * waveAmp * scaleX * (0.35 + prog * 0.9);
          ctx.globalAlpha = reflAlpha * (1 - prog * 0.78);
          ctx.drawImage(waterReflCanvas, 0, srcRow, srcW, hStep, srcX + waveDx, sy + ry, srcW, hStep);
        }
        ctx.restore();
      }
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(wx, wy, ww, wh);
    ctx.clip();
    var wg = ctx.createLinearGradient(wx, wy, wx, wy + wh);
    wg.addColorStop(0, topCol);
    wg.addColorStop(1, deepCol);
    ctx.fillStyle = wg;
    ctx.fillRect(wx, wy, ww, wh);

    // Subtle caustic bands & surface wave crest
    ctx.strokeStyle = 'rgba(224, 242, 254, 0.14)';
    ctx.lineWidth = 1.5;
    for (var ci = 0; ci < 3; ci++) {
      var cyOff = wy + wh * (0.28 + ci * 0.26);
      ctx.beginPath();
      for (var cxp = wx; cxp <= wx + ww; cxp += 18) {
        var cyw = cyOff + Math.sin(gameTime * (waveSpd * 0.65) + cxp * 0.045 + ci * 2.1) * (waveAmp * 0.7);
        if (cxp === wx) ctx.moveTo(cxp, cyw);
        else ctx.lineTo(cxp, cyw);
      }
      ctx.stroke();
    }

    // Animated waterline crest + entity splash disturbance
    ctx.strokeStyle = hiCol;
    ctx.lineWidth = Math.max(1.5, Number(o.crestWidth) || 2.2);
    ctx.beginPath();
    var stepX = Math.max(6, Math.min(16, ww / 24));
    for (var px = wx; px <= wx + ww + stepX * 0.5; px += stepX) {
      var pxClamp = Math.min(wx + ww, px);
      var dy = Math.sin(gameTime * waveSpd + pxClamp * 0.08) * (waveAmp * 0.55);
      for (var ei = 0; ei < worldEntities.length; ei++) {
        var ent = worldEntities[ei];
        if (!ent || ent.alive === false) continue;
        var ex = Number(ent.x) || 0, ey = Number(ent.y) || 0;
        if (Math.abs(ey - wy) < 28 && ex >= wx - 24 && ex <= wx + ww + 24) {
          var dxEnt = pxClamp - ex;
          var dEnt = Math.abs(dxEnt);
          if (dEnt < 32) {
            dy += Math.cos(dEnt * 0.25 - gameTime * 10) * (1 - dEnt / 32) * (waveAmp * 1.4);
          }
        }
      }
      if (px === wx) ctx.moveTo(pxClamp, wy + dy + 1);
      else ctx.lineTo(pxClamp, wy + dy + 1);
    }
    ctx.stroke();
    ctx.restore();
  }

  // --- v6.1 Verlet Rope / Cape / Tentacle Chain ---
  function ropeChain(x, y, count, segLen, opts) {
    var o = isOptsObj(x) ? x : (isOptsObj(opts) ? opts : {});
    var rx = isOptsObj(x) ? (Number(o.x) || 0) : (Number(x) || 0);
    var ry = isOptsObj(x) ? (Number(o.y) || 0) : (Number(y) || 0);
    var cnt = Math.max(2, Math.min(120, Math.round(isOptsObj(x) ? (o.count || 10) : (count || 10))));
    var sl = Math.max(2, Number(isOptsObj(x) ? (o.segLen || 14) : (segLen || 14)));
    var grav = o.gravity === undefined ? 680 : Number(o.gravity);
    var damp = o.damping === undefined ? 0.985 : Math.max(0.5, Math.min(0.999, Number(o.damping)));
    var stiff = Math.max(1, Math.min(20, Math.round(o.stiffness === undefined ? 6 : o.stiffness)));
    var windVal = Number(o.wind) || 0;
    var pinStart = o.pinStart !== false;
    var pinEnd = !!o.pinEnd;
    var pts = [];
    for (var i = 0; i < cnt; i++) {
      pts.push({ x: rx, y: ry + i * sl, ox: rx, oy: ry + i * sl, pinned: (i === 0 && pinStart) || (i === cnt - 1 && pinEnd) });
    }
    var chainObj = {
      points: pts,
      count: cnt,
      segLen: sl,
      gravity: grav,
      damping: damp,
      wind: windVal,
      stiffness: stiff,
      obstacles: o.obstacles || null,
      pin: function(idx, px, py) {
        var i0 = Math.max(0, Math.min(pts.length - 1, Math.round(idx) || 0));
        pts[i0].pinned = true;
        if (px !== undefined) { pts[i0].x = Number(px) || 0; pts[i0].ox = pts[i0].x; }
        if (py !== undefined) { pts[i0].y = Number(py) || 0; pts[i0].oy = pts[i0].y; }
        return chainObj;
      },
      unpin: function(idx) {
        var i0 = Math.max(0, Math.min(pts.length - 1, Math.round(idx) || 0));
        pts[i0].pinned = false;
        return chainObj;
      },
      attachEnd: function(px, py) {
        return chainObj.pin(pts.length - 1, px, py);
      },
      applyForce: function(fx, fy) {
        for (var i = 0; i < pts.length; i++) {
          if (pts[i].pinned) continue;
          pts[i].ox -= (Number(fx) || 0) * 0.016;
          pts[i].oy -= (Number(fy) || 0) * 0.016;
        }
      },
      getEnd: function() { return pts[pts.length - 1]; },
      update: function(dt, headX, headY, endX, endY) {
        var dSec = Math.max(0.001, Math.min(0.035, dt === undefined ? 0.016 : Number(dt) || 0.016));
        if (headX !== undefined && headY !== undefined) {
          pts[0].pinned = true;
          pts[0].x = Number(headX) || 0; pts[0].y = Number(headY) || 0;
          pts[0].ox = pts[0].x; pts[0].oy = pts[0].y;
        }
        if (endX !== undefined && endY !== undefined) {
          var lastP = pts[pts.length - 1];
          lastP.pinned = true;
          lastP.x = Number(endX) || 0; lastP.y = Number(endY) || 0;
          lastP.ox = lastP.x; lastP.oy = lastP.y;
        }
        var dt2 = dSec * dSec;
        for (var i = 0; i < pts.length; i++) {
          var p = pts[i];
          if (p.pinned) continue;
          var vx = (p.x - p.ox) * chainObj.damping;
          var vy = (p.y - p.oy) * chainObj.damping;
          p.ox = p.x; p.oy = p.y;
          p.x += vx + chainObj.wind * dt2;
          p.y += vy + chainObj.gravity * dt2;
        }
        for (var it = 0; it < chainObj.stiffness; it++) {
          for (var s = 0; s < pts.length - 1; s++) {
            var a = pts[s], b = pts[s + 1];
            var dx = b.x - a.x, dy = b.y - a.y;
            var distVal = Math.hypot(dx, dy) || 0.0001;
            var diff = (distVal - chainObj.segLen) / distVal;
            if (a.pinned && b.pinned) continue;
            if (a.pinned) {
              b.x -= dx * diff; b.y -= dy * diff;
            } else if (b.pinned) {
              a.x += dx * diff; a.y += dy * diff;
            } else {
              a.x += dx * diff * 0.5; a.y += dy * diff * 0.5;
              b.x -= dx * diff * 0.5; b.y -= dy * diff * 0.5;
            }
          }
          if (chainObj.obstacles) {
            var obs = chainObj.obstacles;
            for (var oi = 0; oi < pts.length; oi++) {
              var pt = pts[oi];
              if (pt.pinned) continue;
              if (obs._isTilemap) {
                var tx = Math.floor(pt.x / obs.tileSize), ty = Math.floor(pt.y / obs.tileSize);
                if (obs.solidAt(tx, ty)) {
                  var cxT = (tx + 0.5) * obs.tileSize, cyT = (ty + 0.5) * obs.tileSize;
                  var ddx = pt.x - cxT, ddy = pt.y - cyT;
                  if (Math.abs(ddx) > Math.abs(ddy)) pt.x = ddx > 0 ? (tx + 1) * obs.tileSize + 1 : tx * obs.tileSize - 1;
                  else pt.y = ddy > 0 ? (ty + 1) * obs.tileSize + 1 : ty * obs.tileSize - 1;
                }
              }
            }
          }
        }
        return chainObj;
      },
      draw: function(drawOpts) {
        var do2 = isOptsObj(drawOpts) ? drawOpts : {};
        var w0 = Number(do2.width !== undefined ? do2.width : (o.width !== undefined ? o.width : 4));
        var w1 = Number(do2.widthEnd !== undefined ? do2.widthEnd : (o.widthEnd !== undefined ? o.widthEnd : w0));
        var c0 = do2.color || o.color || '#f59e0b';
        var c1 = do2.colorEnd || o.colorEnd || c0;
        var nRad = Number(do2.nodeRadius !== undefined ? do2.nodeRadius : (o.nodeRadius || 0));
        var nCol = do2.nodeColor || o.nodeColor || c0;
        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        if (w0 === w1 && c0 === c1) {
          ctx.strokeStyle = c0;
          ctx.lineWidth = w0;
          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
          ctx.stroke();
        } else {
          for (var j = 0; j < pts.length - 1; j++) {
            var t = j / Math.max(1, pts.length - 2);
            ctx.strokeStyle = lerpColor(c0, c1, t);
            ctx.lineWidth = Math.max(0.5, w0 + (w1 - w0) * t);
            ctx.beginPath();
            ctx.moveTo(pts[j].x, pts[j].y);
            ctx.lineTo(pts[j + 1].x, pts[j + 1].y);
            ctx.stroke();
          }
        }
        if (nRad > 0) {
          ctx.fillStyle = nCol;
          for (var ni = 0; ni < pts.length; ni++) {
            ctx.beginPath();
            ctx.arc(pts[ni].x, pts[ni].y, nRad, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        ctx.restore();
      }
    };
    return chainObj;
  }

  // --- v6.1 Analytical 2-Bone Inverse Kinematics ---
  function limbIK(rx, ry, l1, l2, tx, ty, flipOrOpts) {
    var o = isOptsObj(flipOrOpts) ? flipOrOpts : {};
    var flip = isOptsObj(flipOrOpts) ? !!o.flip : !!flipOrOpts;
    var aLen = Math.max(1, Number(l1) || 24), bLen = Math.max(1, Number(l2) || 24);
    var x0 = Number(rx) || 0, y0 = Number(ry) || 0, xT = Number(tx) || 0, yT = Number(ty) || 0;
    var dx = xT - x0, dy = yT - y0;
    var origD = Math.hypot(dx, dy);
    var minD = Math.max(0.001, Math.abs(aLen - bLen) + 0.001);
    var maxD = Math.max(minD + 0.001, aLen + bLen - 0.001);
    var d = Math.max(minD, Math.min(maxD, origD || 0.001));
    var baseAng = Math.atan2(dy, dx);
    var cosA = Math.max(-1, Math.min(1, (aLen * aLen + d * d - bLen * bLen) / (2 * aLen * d)));
    var offsetA = Math.acos(cosA);
    var ang1 = baseAng + (flip ? -offsetA : offsetA);
    var jx = x0 + Math.cos(ang1) * aLen;
    var jy = y0 + Math.sin(ang1) * aLen;
    var ang2 = Math.atan2(yT - jy, xT - jx);
    if (origD > maxD || origD < minD) {
      ang2 = Math.atan2((y0 + Math.sin(baseAng) * d) - jy, (x0 + Math.cos(baseAng) * d) - jx);
    }
    var ex = jx + Math.cos(ang2) * bLen;
    var ey = jy + Math.sin(ang2) * bLen;
    var res = {
      x: x0, y: y0, jointX: jx, jointY: jy, endX: ex, endY: ey,
      angle1: ang1, angle2: ang2, dist: d, reached: origD <= aLen + bLen + 0.01,
      draw: function(drawOpts) {
        var do2 = isOptsObj(drawOpts) ? drawOpts : o;
        var lw1 = Number(do2.width1 !== undefined ? do2.width1 : (do2.width || 6));
        var lw2 = Number(do2.width2 !== undefined ? do2.width2 : Math.max(2, lw1 * 0.78));
        var col1 = do2.color || '#cbd5e1';
        var col2 = do2.color2 || col1;
        var jCol = do2.jointColor || '#38bdf8';
        var eCol = do2.endColor || '#f43f5e';
        ctx.save();
        ctx.lineCap = 'round';
        ctx.strokeStyle = col1; ctx.lineWidth = lw1;
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(jx, jy); ctx.stroke();
        ctx.strokeStyle = col2; ctx.lineWidth = lw2;
        ctx.beginPath(); ctx.moveTo(jx, jy); ctx.lineTo(ex, ey); ctx.stroke();
        if (do2.joints !== false) {
          ctx.fillStyle = jCol;
          ctx.beginPath(); ctx.arc(jx, jy, Math.max(2.5, lw1 * 0.55), 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = eCol;
          ctx.beginPath(); ctx.arc(ex, ey, Math.max(2.2, lw2 * 0.55), 0, Math.PI * 2); ctx.fill();
        }
        ctx.restore();
        return res;
      }
    };
    if (o.draw) res.draw(o);
    return res;
  }

  // --- v6.1 Inventory / Shop UI Grid + Screen-Safe Tooltip ---
  function tooltip(textOrOpts, tx, ty) {
    var o = isOptsObj(textOrOpts) ? textOrOpts : {};
    var bodyStr = isOptsObj(textOrOpts) ? String(o.text || o.desc || '') : String(textOrOpts === undefined || textOrOpts === null ? '' : textOrOpts);
    var titleStr = o.title ? String(o.title) : '';
    if (!bodyStr && !titleStr) return;
    queuedTooltips.push({
      title: titleStr,
      text: bodyStr,
      bg: o.bg || 'rgba(15, 23, 42, 0.96)',
      border: o.border || '#38bdf8',
      color: o.color || '#e2e8f0',
      titleColor: o.titleColor || '#f8fafc',
      maxW: Math.max(120, Math.min(W - 32, Number(o.maxW) || 260)),
      x: tx !== undefined ? Number(tx) : (o.x !== undefined ? Number(o.x) : (mouse.x + 14)),
      y: ty !== undefined ? Number(ty) : (o.y !== undefined ? Number(o.y) : (mouse.y + 18))
    });
  }

  function renderQueuedTooltips() {
    if (queuedTooltips.length === 0) return;
    ctx = rootCtx;
    ctx.save();
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    for (var i = 0; i < queuedTooltips.length; i++) {
      var tt = queuedTooltips[i];
      var pad = 10, maxInner = tt.maxW - pad * 2;
      ctx.font = '700 13px ' + fontFamily;
      var tLines = [];
      if (tt.title) tLines.push({ text: tt.title, bold: true, col: tt.titleColor });
      ctx.font = '500 12px ' + fontFamily;
      var rawLines = String(tt.text || '').split('\\n');
      for (var ri = 0; ri < rawLines.length; ri++) {
        var words = rawLines[ri].split(' ');
        var cur = '';
        for (var wi = 0; wi < words.length; wi++) {
          var cand = cur ? (cur + ' ' + words[wi]) : words[wi];
          if (ctx.measureText(cand).width > maxInner && cur) {
            tLines.push({ text: cur, bold: false, col: tt.color });
            cur = words[wi];
          } else cur = cand;
        }
        if (cur || words.length === 1) tLines.push({ text: cur, bold: false, col: tt.color });
      }
      var maxLineW = 40;
      for (var li = 0; li < tLines.length; li++) {
        ctx.font = (tLines[li].bold ? '700 13px ' : '500 12px ') + fontFamily;
        var lw = ctx.measureText(tLines[li].text).width;
        if (lw > maxLineW) maxLineW = lw;
      }
      var bw = Math.min(tt.maxW, maxLineW + pad * 2);
      var lineH = 16;
      var bh = pad * 2 + tLines.length * lineH + (tt.title && tt.text ? 4 : 0);
      var bx = Math.max(8, Math.min(W - bw - 8, tt.x));
      var by = Math.max(8, Math.min(H - bh - 8, tt.y));
      drawRect(bx, by, bw, bh, tt.bg, 8);
      strokeRect(bx, by, bw, bh, tt.border, 1.5);
      var curY = by + pad;
      for (var lj = 0; lj < tLines.length; lj++) {
        var ln = tLines[lj];
        ctx.font = (ln.bold ? '700 13px ' : '500 12px ') + fontFamily;
        ctx.fillStyle = ln.col;
        ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.fillText(ln.text, bx + pad, curY);
        curY += lineH + (ln.bold && tt.text ? 4 : 0);
      }
    }
    ctx.restore();
    queuedTooltips.length = 0;
  }

  function uiGrid(x, y, cols, rows, cellSizeOrOpts, items, drawCellFn) {
    var o = isOptsObj(x) ? x : (isOptsObj(cellSizeOrOpts) ? cellSizeOrOpts : {});
    var gx = isOptsObj(x) ? (Number(o.x) || 0) : (Number(x) || 0);
    var gy = isOptsObj(x) ? (Number(o.y) || 0) : (Number(y) || 0);
    var gCols = Math.max(1, Math.round(isOptsObj(x) ? (o.cols || 4) : (cols || 4)));
    var gRows = Math.max(1, Math.round(isOptsObj(x) ? (o.rows || 4) : (rows || 4)));
    var cw = Number(o.cellW !== undefined ? o.cellW : (o.cellSize !== undefined ? o.cellSize : (!isOptsObj(x) && !isOptsObj(cellSizeOrOpts) && cellSizeOrOpts !== undefined ? cellSizeOrOpts : 48)));
    var ch = Number(o.cellH !== undefined ? o.cellH : cw);
    var gap = Number(o.gap !== undefined ? o.gap : 6);
    var pad = Number(o.pad !== undefined ? o.pad : 8);
    var rad = Number(o.radius !== undefined ? o.radius : 8);
    var itemList = Array.isArray(o.items) ? o.items : (Array.isArray(items) ? items : (typeof items === 'function' ? [] : []));
    var cb = typeof drawCellFn === 'function' ? drawCellFn : (typeof items === 'function' ? items : (typeof o.draw === 'function' ? o.draw : null));
    var selectedIdx = o.selected !== undefined ? Number(o.selected) : -1;

    var totalW = pad * 2 + gCols * cw + (gCols - 1) * gap;
    var totalH = pad * 2 + gRows * ch + (gRows - 1) * gap;
    if (o.bg !== null) {
      drawRect(gx, gy, totalW, totalH, o.bg || 'rgba(15, 23, 42, 0.88)', rad);
      if (o.border !== null) strokeRect(gx, gy, totalW, totalH, o.border || 'rgba(148, 163, 184, 0.35)', 1.5);
    }

    var mx = mouse.x - uiScrollOffset.x, my = mouse.y - uiScrollOffset.y;
    if (mx >= gx && mx <= gx + totalW && my >= gy && my <= gy + totalH) mouse.overUi = true;

    var hoveredIndex = -1, clickedIndex = -1, rightClickedIndex = -1;
    var cells = [];
    for (var r = 0; r < gRows; r++) {
      for (var c = 0; c < gCols; c++) {
        var idx = r * gCols + c;
        var cx = gx + pad + c * (cw + gap);
        var cy = gy + pad + r * (ch + gap);
        var hov = mx >= cx && mx <= cx + cw && my >= cy && my <= cy + ch;
        var isSel = idx === selectedIdx;
        if (hov) {
          hoveredIndex = idx;
          mouse.overUi = true;
          if (mouse.clicked) clickedIndex = idx;
          if (mouse.rightClicked) rightClickedIndex = idx;
        }
        var cellBg = isSel ? (o.cellSelected || 'rgba(56, 189, 248, 0.25)') : (hov ? (o.cellHover || 'rgba(51, 65, 85, 0.9)') : (o.cellBg || 'rgba(30, 41, 59, 0.78)'));
        var cellBdr = isSel ? '#38bdf8' : (hov ? '#7dd3fc' : 'rgba(148, 163, 184, 0.24)');
        drawRect(cx, cy, cw, ch, cellBg, Math.min(rad, 6));
        strokeRect(cx, cy, cw, ch, cellBdr, isSel ? 2 : 1);

        var it = idx < itemList.length ? itemList[idx] : null;
        if (cb) {
          cb(idx, cx, cy, cw, ch, c, r, hov, it);
        } else if (it) {
          if (it.sprite && typeof it.sprite.draw === 'function') {
            it.sprite.draw(cx + cw * 0.5, cy + ch * 0.5, 0, Math.min(1, (cw - 10) / 32));
          } else if (it.color) {
            drawRect(cx + 8, cy + 8, cw - 16, ch - 16, it.color, 4);
          }
          var lbl = it.icon || it.label || it.name;
          if (lbl !== undefined && lbl !== null) {
            text(String(lbl), cx + cw * 0.5, cy + ch * 0.5 - 6, it.textColor || '#f8fafc', Math.min(14, Math.max(10, cw * 0.26)), 'center');
          }
          if (it.count !== undefined && Number(it.count) > 1) {
            text('x' + it.count, cx + cw - 4, cy + ch - 14, '#fde047', 11, 'right');
          }
          if (hov && (it.tooltip || it.desc || it.name)) {
            tooltip(it.tooltip || { title: it.name || '', text: it.desc || '' });
          }
        }
        cells.push({ index: idx, x: cx, y: cy, w: cw, h: ch, col: c, row: r, hovered: hov, item: it });
      }
    }
    return {
      hoveredIndex: hoveredIndex,
      clickedIndex: clickedIndex,
      rightClickedIndex: rightClickedIndex,
      hoveredItem: hoveredIndex >= 0 && hoveredIndex < itemList.length ? itemList[hoveredIndex] : null,
      clickedItem: clickedIndex >= 0 && clickedIndex < itemList.length ? itemList[clickedIndex] : null,
      width: totalW,
      height: totalH,
      cells: cells
    };
  }

  // --- v6.1 Visual Novel / RPG Dialogue Engine ---
  function _loadDialogueNode(key) {
    var node = dialogueState.nodesMap[key];
    if (!node) {
      _closeDialogue(dialogueState.chosenResult);
      return;
    }
    dialogueState.curKey = key;
    dialogueState.speaker = node.speaker ? String(node.speaker) : '';
    dialogueState.fullText = String(node.text !== undefined ? node.text : (typeof node === 'string' ? node : ''));
    dialogueState.shownChars = 0;
    dialogueState.speed = Number(node.speed !== undefined ? node.speed : (dialogueState.opts.speed || 48));
    dialogueState.color = node.color || dialogueState.opts.color || '#38bdf8';
    dialogueState.portrait = node.portrait || null;
    dialogueState.choices = Array.isArray(node.choices) ? node.choices.filter(function(ch) { return !ch.cond || ch.cond(); }) : [];
    dialogueState.choiceRects = [];
    dialogueState.cooldown = 0.08;
    if (typeof node.onEnter === 'function') {
      try { node.onEnter(node); } catch(e) { handleHookError(e); }
    }
  }

  function _closeDialogue(res) {
    if (!dialogueState.active) return;
    var rFn = dialogueState.resolve;
    dialogueState.active = false;
    dialogueState.resolve = null;
    dialogueState.choices = [];
    dialogueState.choiceRects = [];
    if (rFn) rFn(res !== undefined ? res : dialogueState.chosenResult);
  }

  function _advanceDialogue() {
    if (!dialogueState.active || dialogueState.cooldown > 0) return;
    if (dialogueState.shownChars < dialogueState.fullText.length) {
      dialogueState.shownChars = dialogueState.fullText.length;
      return;
    }
    var cur = dialogueState.nodesMap[dialogueState.curKey];
    if (dialogueState.choices.length > 0) return;
    if (cur && cur.next !== undefined && cur.next !== null) {
      _loadDialogueNode(String(cur.next));
    } else {
      var curIdx = dialogueState.order.indexOf(dialogueState.curKey);
      if (curIdx >= 0 && curIdx + 1 < dialogueState.order.length && (!cur || cur.next !== null)) {
        _loadDialogueNode(dialogueState.order[curIdx + 1]);
      } else {
        _closeDialogue(dialogueState.chosenResult);
      }
    }
  }

  function _pickDialogueChoice(idx) {
    if (!dialogueState.active) return false;
    var ch = dialogueState.choices[idx];
    if (!ch) return false;
    dialogueState.chosenResult = ch.value !== undefined ? ch.value : (ch.id !== undefined ? ch.id : idx);
    if (typeof ch.onSelect === 'function') {
      try { ch.onSelect(ch, idx); } catch(e) { handleHookError(e); }
    }
    if (ch.next !== undefined && ch.next !== null) {
      _loadDialogueNode(String(ch.next));
    } else {
      _closeDialogue(dialogueState.chosenResult);
    }
    return true;
  }

  function dialogueHandleKey(e) {
    if (!dialogueState.active) return false;
    if (e.key === ' ' || e.code === 'Space' || e.key === 'Enter') {
      _advanceDialogue();
      return true;
    }
    if (dialogueState.choices.length > 0 && dialogueState.shownChars >= dialogueState.fullText.length) {
      var n = parseInt(e.key, 10);
      if (n >= 1 && n <= dialogueState.choices.length) {
        _pickDialogueChoice(n - 1);
        return true;
      }
    }
    if (e.key === 'Escape' && dialogueState.opts.skippable) {
      _closeDialogue(null);
      return true;
    }
    return false;
  }

  function dialogueHandleClick(sx, sy) {
    if (!dialogueState.active) return false;
    for (var i = 0; i < dialogueState.choiceRects.length; i++) {
      var r = dialogueState.choiceRects[i];
      if (sx >= r.x && sx <= r.x + r.w && sy >= r.y && sy <= r.y + r.h) {
        _pickDialogueChoice(i);
        return true;
      }
    }
    var b = dialogueState.boxRect;
    if (b && sx >= b.x && sx <= b.x + b.w && sy >= b.y && sy <= b.y + b.h) {
      _advanceDialogue();
      return true;
    }
    return false;
  }

  function renderDialogueOverlay(forceDraw) {
    if (!dialogueState.active) return;
    if (!forceDraw && dialogueState.drawnThisFrame) return;
    dialogueState.drawnThisFrame = true;
    ctx = rootCtx;
    ctx.save();
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    var o = dialogueState.opts;
    var bw = Math.min(W - 32, Number(o.width) || 680);
    var bh = Math.min(H - 32, Number(o.height) || 138);
    var bx = o.x !== undefined ? Number(o.x) : (W - bw) * 0.5;
    var by = o.y !== undefined ? Number(o.y) : (H - bh - 18);
    dialogueState.boxRect = { x: bx, y: by, w: bw, h: bh };
    if (mouse.x >= bx && mouse.x <= bx + bw && mouse.y >= by && mouse.y <= by + bh) mouse.overUi = true;

    drawRect(bx, by, bw, bh, o.bg || 'rgba(9, 13, 26, 0.94)', 12);
    strokeRect(bx, by, bw, bh, dialogueState.color, 2);

    var textStartX = bx + 18;
    var textMaxW = bw - 36;
    if (dialogueState.portrait) {
      var pBox = bh - 24;
      drawRect(bx + 12, by + 12, pBox, pBox, 'rgba(30, 41, 59, 0.85)', 8);
      strokeRect(bx + 12, by + 12, pBox, pBox, 'rgba(148,163,184,0.35)', 1);
      if (typeof dialogueState.portrait.draw === 'function') {
        dialogueState.portrait.draw(bx + 12 + pBox * 0.5, by + 12 + pBox * 0.5, 0, 1);
      } else {
        text(String(dialogueState.portrait), bx + 12 + pBox * 0.5, by + 12 + pBox * 0.5 - 12, '#f8fafc', 26, 'center');
      }
      textStartX += pBox + 12;
      textMaxW -= pBox + 12;
    }

    if (dialogueState.speaker) {
      var spW = Math.max(90, measureTextBox(dialogueState.speaker, 14).width + 24);
      drawRect(bx + 16, by - 14, spW, 24, dialogueState.color, 6);
      text(dialogueState.speaker, bx + 16 + spW * 0.5, by - 9, '#090d16', 13, 'center');
    }

    var visText = dialogueState.fullText.slice(0, Math.floor(dialogueState.shownChars));
    textWrap(visText, textStartX, by + 20, textMaxW, o.textColor || '#f1f5f9', Number(o.fontSize) || 16, 'left', 22);

    var fullyShown = dialogueState.shownChars >= dialogueState.fullText.length;
    dialogueState.choiceRects.length = 0;
    if (fullyShown && dialogueState.choices.length > 0) {
      var chLen = dialogueState.choices.length;
      for (var ci = 0; ci < chLen; ci++) {
        var ch = dialogueState.choices[ci];
        var chH = 32;
        var chW = Math.min(340, bw - 32);
        var chX = bx + bw - chW - 12;
        var chY = by - 16 - (chLen - ci) * (chH + 6);
        var hovC = mouse.x >= chX && mouse.x <= chX + chW && mouse.y >= chY && mouse.y <= chY + chH;
        if (hovC) mouse.overUi = true;
        drawRect(chX, chY, chW, chH, hovC ? dialogueState.color : 'rgba(15, 23, 42, 0.95)', 7);
        strokeRect(chX, chY, chW, chH, dialogueState.color, 1.5);
        text((ci + 1) + '. ' + String(ch.text || ch.label || ''), chX + 12, chY + 9, hovC ? '#090d16' : '#f8fafc', 13, 'left');
        dialogueState.choiceRects.push({ x: chX, y: chY, w: chW, h: chH });
      }
    } else if (fullyShown && Math.floor(gameTime * 3) % 2 === 0) {
      text('▼ Space / Click', bx + bw - 14, by + bh - 22, dialogueState.color, 11, 'right');
    }
    ctx.restore();
  }

  function dialogue(script, opts) {
    var o = isOptsObj(opts) ? opts : {};
    if (dialogueState.active) _closeDialogue(null);
    var nodesMap = {};
    var order = [];
    if (typeof script === 'string') {
      nodesMap['0'] = { text: script, speaker: o.speaker || '' };
      order.push('0');
    } else if (Array.isArray(script)) {
      for (var i = 0; i < script.length; i++) {
        var item = typeof script[i] === 'string' ? { text: script[i] } : script[i];
        var k = String(item && item.id !== undefined ? item.id : i);
        nodesMap[k] = item || { text: '' };
        order.push(k);
      }
    } else if (script && typeof script === 'object') {
      Object.keys(script).forEach(function(k) {
        nodesMap[k] = script[k];
        order.push(k);
      });
    }
    dialogueState.nodesMap = nodesMap;
    dialogueState.order = order;
    dialogueState.opts = o;
    dialogueState.chosenResult = null;
    dialogueState.drawnThisFrame = false;
    var p = new Promise(function(resolve) {
      dialogueState.resolve = resolve;
    });
    if (order.length === 0) {
      dialogueState.active = false;
      dialogueState.resolve(null);
      dialogueState.resolve = null;
      return p;
    }
    dialogueState.active = true;
    var startK = (o.startNode && nodesMap[o.startNode]) ? String(o.startNode) : (nodesMap.start ? 'start' : order[0]);
    _loadDialogueNode(startK);
    p.close = _closeDialogue;
    p.next = _advanceDialogue;
    p.choose = _pickDialogueChoice;
    p.draw = function() { renderDialogueOverlay(true); };
    return p;
  }
  Object.defineProperty(dialogue, 'active', { get: function() { return dialogueState.active; } });
  dialogue.close = _closeDialogue;
  dialogue.next = _advanceDialogue;
  dialogue.choose = _pickDialogueChoice;
  dialogue.draw = function() { renderDialogueOverlay(true); };

  // --- v6.1 Ghost Snapshots (Speedrun / Replay Recording & Playback) ---
  function ghostRecord(targetOrSampler, opts) {
    var o = isOptsObj(opts) ? opts : (isOptsObj(targetOrSampler) ? targetOrSampler : {});
    var tgt = typeof targetOrSampler === 'function' ? null : (isOptsObj(targetOrSampler) ? (o.target || cam.followTarget || worldEntities[0]) : (targetOrSampler || cam.followTarget || worldEntities[0]));
    ghostRec.active = true;
    ghostRec.target = tgt || null;
    ghostRec.sampler = typeof targetOrSampler === 'function' ? targetOrSampler : null;
    ghostRec.rate = Math.max(5, Math.min(60, Number(o.hz || o.rate) || 30));
    ghostRec.maxDur = Math.max(5, Number(o.maxDur) || 180);
    ghostRec.acc = 1 / ghostRec.rate;
    ghostRec.t = 0;
    ghostRec.frames = [];
    return ghostRec;
  }

  function ghostStop() {
    ghostRec.active = false;
    var clip = { version: 1, dur: ghostRec.t, frames: ghostRec.frames.slice() };
    f3GhostClip = clip;
    return clip;
  }

  function _sampleGhostFrames(frames, tSec) {
    if (!frames || frames.length === 0) return null;
    if (frames.length === 1 || tSec <= frames[0].t) return frames[0];
    var last = frames[frames.length - 1];
    if (tSec >= last.t) return last;
    var lo = 0, hi = frames.length - 1;
    while (lo + 1 < hi) {
      var mid = (lo + hi) >> 1;
      if (frames[mid].t <= tSec) lo = mid; else hi = mid;
    }
    var a = frames[lo], b = frames[hi];
    var span = (b.t - a.t) || 0.0001;
    var k = Math.max(0, Math.min(1, (tSec - a.t) / span));
    return {
      t: tSec,
      x: a.x + (b.x - a.x) * k,
      y: a.y + (b.y - a.y) * k,
      rot: a.rot + (b.rot - a.rot) * k,
      w: a.w, h: a.h, r: a.r, _shape: a._shape, state: a.state
    };
  }

  function ghostPlay(clip, drawFnOrOpts) {
    var frames = Array.isArray(clip) ? clip : (clip && Array.isArray(clip.frames) ? clip.frames : []);
    var o = isOptsObj(drawFnOrOpts) ? drawFnOrOpts : {};
    var dur = frames.length ? (frames[frames.length - 1].t || 0.01) : 0;
    var gp = {
      active: frames.length > 0,
      done: frames.length === 0,
      time: 0,
      dur: dur,
      speed: Number(o.speed !== undefined ? o.speed : 1),
      loop: !!o.loop,
      color: o.color || '#38bdf8',
      alpha: o.alpha !== undefined ? Number(o.alpha) : 0.42,
      customDraw: typeof drawFnOrOpts === 'function' ? drawFnOrOpts : (typeof o.draw === 'function' ? o.draw : null),
      sample: function(tOpt) { return _sampleGhostFrames(frames, tOpt !== undefined ? Number(tOpt) : gp.time); },
      stop: function() { gp.active = false; gp.done = true; },
      get progress() { return gp.dur > 0 ? Math.min(1, gp.time / gp.dur) : 1; },
      draw: function() {
        var smp = _sampleGhostFrames(frames, gp.time);
        if (!smp) return;
        if (gp.customDraw) { gp.customDraw(smp); return; }
        ctx.save();
        ctx.globalAlpha = gp.alpha;
        if (o.sprite && typeof o.sprite.draw === 'function') {
          o.sprite.draw(smp.x, smp.y, smp.rot, 1, false);
        } else if (smp._shape === 'circle' || (smp.r && !smp.w)) {
          drawCircle(smp.x, smp.y, Number(o.radius || smp.r || 12), gp.color);
          strokeCircle(smp.x, smp.y, Number(o.radius || smp.r || 12) + 2, '#e0f2fe', 1.5);
        } else {
          var gw = Number(smp.w || 24), gh = Number(smp.h || 24);
          drawRect(smp.x, smp.y, gw, gh, gp.color, 5);
          strokeRect(smp.x, smp.y, gw, gh, '#e0f2fe', 1.5);
        }
        ctx.restore();
      }
    };
    if (gp.active) ghostPlayers.push(gp);
    return gp;
  }

  function updateAndDrawGhosts(dt, doDraw) {
    if (ghostRec.active && dt > 0 && !doDraw) {
      ghostRec.t += dt;
      ghostRec.acc += dt;
      var stepS = 1 / ghostRec.rate;
      if (ghostRec.acc >= stepS) {
        ghostRec.acc -= stepS;
        var smp = null;
        if (ghostRec.sampler) {
          var cs = ghostRec.sampler();
          if (cs && typeof cs === 'object') smp = Object.assign({ t: ghostRec.t, x: 0, y: 0, rot: 0 }, cs);
        } else if (ghostRec.target) {
          var tg = ghostRec.target;
          smp = {
            t: ghostRec.t, x: Number(tg.x) || 0, y: Number(tg.y) || 0, rot: Number(tg.rot) || 0,
            w: tg.w, h: tg.h, r: tg.r, _shape: tg._shape, state: tg.state
          };
        }
        if (smp) ghostRec.frames.push(smp);
        if (ghostRec.t >= ghostRec.maxDur) ghostStop();
      }
    }
    if (!doDraw) {
      for (var i = ghostPlayers.length - 1; i >= 0; i--) {
        var gp = ghostPlayers[i];
        if (!gp.active) { ghostPlayers.splice(i, 1); continue; }
        gp.time += dt * gp.speed;
        if (gp.time >= gp.dur) {
          if (gp.loop && gp.dur > 0) gp.time = gp.time % gp.dur;
          else { gp.time = gp.dur; gp.done = true; gp.active = false; }
        }
      }
    } else {
      for (var j = 0; j < ghostPlayers.length; j++) {
        if (ghostPlayers[j].active) ghostPlayers[j].draw();
      }
    }
  }

  // --- v6.1 Real-Time Multiplayer NetSync over RoySDK.rooms ---
  function netSync(targetOrOpts, opts) {
    var o = isOptsObj(opts) ? opts : (isOptsObj(targetOrOpts) ? targetOrOpts : {});
    var localEnt = isOptsObj(targetOrOpts) ? (o.entity || o.target || null) : (targetOrOpts || null);
    var props = Array.isArray(o.props) ? o.props : ['x', 'y', 'vx', 'vy', 'rot', 'state'];
    var sendRate = Math.max(2, Math.min(30, Number(o.rate) || 15));
    var interpSpd = Math.max(1, Math.min(40, Number(o.interpolate) || 14));
    var me = sdk.player.getSync();
    var myId = String(me.username || 'guest').replace(/[^a-zA-Z0-9_-]/g, '_') + '_' + Math.random().toString(36).slice(2, 6);
    var peerPrefix = '_p_';
    var stateCache = {};
    var peersById = {};
    var listeners = {};
    var unsubs = [];
    var stopped = false;

    var ns = {
      id: myId,
      connected: false,
      roomId: '',
      isHost: false,
      sendAcc: 0,
      lastSentJson: '',
      sharedState: {},
      stop: function() {
        stopped = true;
        ns.connected = false;
        while (unsubs.length) {
          var u = unsubs.pop();
          try { if (typeof u === 'function') u(); } catch(e) {}
        }
        var ix = activeNetSyncs.indexOf(ns);
        if (ix >= 0) activeNetSyncs.splice(ix, 1);
      },
      on: function(evName, fn) {
        if (typeof fn !== 'function') return;
        if (!listeners[evName]) listeners[evName] = [];
        listeners[evName].push(fn);
      },
      send: function(evName, payload) {
        if (!ns.connected || !sdk.rooms || typeof sdk.rooms.sendEvent !== 'function') return Promise.resolve(false);
        var pl = (payload && typeof payload === 'object') ? Object.assign({}, payload, { _fromNetId: myId }) : { value: payload, _fromNetId: myId };
        return sdk.rooms.sendEvent(evName, pl);
      },
      setShared: function(keyOrPatch, val) {
        if (!ns.connected || !sdk.rooms || typeof sdk.rooms.setState !== 'function') return Promise.resolve(false);
        var patch = typeof keyOrPatch === 'object' ? keyOrPatch : (function(){ var p = {}; p[String(keyOrPatch)] = val; return p; })();
        return sdk.rooms.setState(patch);
      },
      getShared: function(key, defVal) {
        return Object.prototype.hasOwnProperty.call(ns.sharedState, key) ? ns.sharedState[key] : defVal;
      },
      peers: function() {
        var out = [];
        var nowMs = Date.now();
        Object.keys(peersById).forEach(function(pid) {
          var p = peersById[pid];
          if (nowMs - (p.ts || nowMs) < 15000) out.push(p);
        });
        return out;
      },
      allPeers: function() {
        var list = ns.peers();
        if (localEnt) {
          var selfObj = { id: myId, name: me.username || myId, self: true, x: localEnt.x || 0, y: localEnt.y || 0, rot: localEnt.rot || 0, state: localEnt.state };
          list.unshift(selfObj);
        }
        return list;
      },
      drawPeers: function(customFn) {
        var fn = typeof customFn === 'function' ? customFn : (typeof o.drawPeer === 'function' ? o.drawPeer : null);
        var list = ns.peers();
        for (var i = 0; i < list.length; i++) {
          var pr = list[i];
          if (fn) { fn(pr); continue; }
          ctx.save();
          drawCircle(pr.x || 0, pr.y || 0, 14, '#38bdf8');
          strokeCircle(pr.x || 0, pr.y || 0, 14, '#f8fafc', 2);
          text(String(pr.name || pr.id), pr.x || 0, (pr.y || 0) - 24, '#e2e8f0', 11, 'center');
          ctx.restore();
        }
      },
      _attachSubs: function() {
        if (stopped || !sdk.rooms) return;
        unsubs.push(sdk.rooms.onState(function(st) {
          if (stopped || !st || typeof st !== 'object') return;
          stateCache = st;
          var nextShared = {};
          var seenPeerKeys = {};
          Object.keys(st).forEach(function(k) {
            if (k.indexOf(peerPrefix) === 0) {
              var pid = k.slice(peerPrefix.length);
              if (pid === myId) return;
              var snap = st[k];
              if (!snap || typeof snap !== 'object') return;
              seenPeerKeys[pid] = true;
              if (!peersById[pid]) {
                peersById[pid] = Object.assign({ id: pid, _target: Object.assign({}, snap) }, snap);
                if (typeof o.onJoin === 'function') { try { o.onJoin(peersById[pid]); } catch(e) {} }
              } else {
                peersById[pid]._target = Object.assign({}, snap);
                Object.keys(snap).forEach(function(pk) {
                  if (pk !== 'x' && pk !== 'y' && pk !== 'rot') peersById[pid][pk] = snap[pk];
                });
              }
            } else {
              nextShared[k] = st[k];
            }
          });
          Object.keys(peersById).forEach(function(pid) {
            if (!seenPeerKeys[pid]) {
              var leftP = peersById[pid];
              delete peersById[pid];
              if (typeof o.onLeave === 'function') { try { o.onLeave(leftP); } catch(e) {} }
            }
          });
          ns.sharedState = nextShared;
          if (typeof o.onState === 'function') { try { o.onState(nextShared); } catch(e) {} }
        }));
        if (typeof sdk.rooms.onEvent === 'function') {
          unsubs.push(sdk.rooms.onEvent(function(ev) {
            if (stopped || !ev) return;
            if (ev.payload && ev.payload._fromNetId === myId && !o.includeSelf) return;
            var arr = listeners[ev.event];
            if (arr) arr.forEach(function(fn) { try { fn(ev.payload, ev.from, ev); } catch(e) { handleHookError(e); } });
            if (typeof o.onEvent === 'function') { try { o.onEvent(ev.event, ev.payload, ev.from, ev); } catch(e) { handleHookError(e); } }
          }));
        }
      },
      connect: function(roomTarget) {
        if (!sdk.rooms || typeof sdk.rooms.list !== 'function') return Promise.resolve(null);
        var desiredName = String(roomTarget || o.roomName || 'Lobby');
        return sdk.rooms.list().then(function(list) {
          var arr = Array.isArray(list) ? list : [];
          var found = arr.find(function(r) { return r && (r.id === desiredName || r.name === desiredName) && r.playerCount < (r.maxPlayers || 8); });
          if (found) {
            return sdk.rooms.join(found.id).then(function(rm) {
              ns.connected = true; ns.roomId = rm.id || found.id; ns.isHost = false; ns._attachSubs(); return rm;
            });
          }
          return sdk.rooms.create({ name: desiredName, maxPlayers: Number(o.maxPlayers) || 8, state: {} }).then(function(rm) {
            ns.connected = true; ns.roomId = rm.id || ''; ns.isHost = true; ns._attachSubs(); return rm;
          });
        }).catch(function(err) {
          emitConsole('warn', 'netSync connect: ' + (err && err.message ? err.message : String(err)));
          return null;
        });
      },
      _tick: function(dt) {
        if (stopped) return;
        var alpha = Math.min(1, 1 - Math.exp(-interpSpd * dt));
        Object.keys(peersById).forEach(function(pid) {
          var p = peersById[pid];
          var tg = p._target;
          if (!tg) return;
          if (tg.x !== undefined) p.x = (p.x !== undefined ? p.x : tg.x) + (Number(tg.x) - (p.x !== undefined ? p.x : tg.x)) * alpha;
          if (tg.y !== undefined) p.y = (p.y !== undefined ? p.y : tg.y) + (Number(tg.y) - (p.y !== undefined ? p.y : tg.y)) * alpha;
          if (tg.rot !== undefined) p.rot = (p.rot !== undefined ? p.rot : tg.rot) + (Number(tg.rot) - (p.rot !== undefined ? p.rot : tg.rot)) * alpha;
        });
        if (!ns.connected || !localEnt || !sdk.rooms || typeof sdk.rooms.setState !== 'function') return;
        ns.sendAcc += dt;
        if (ns.sendAcc >= 1 / sendRate) {
          ns.sendAcc = 0;
          var snap = { name: me.username || myId, ts: Date.now() };
          for (var i = 0; i < props.length; i++) {
            var pk = props[i];
            if (localEnt[pk] !== undefined) {
              snap[pk] = typeof localEnt[pk] === 'number' ? Math.round(localEnt[pk] * 100) / 100 : localEnt[pk];
            }
          }
          var checkObj = Object.assign({}, snap); delete checkObj.ts;
          var sig = JSON.stringify(checkObj);
          if (sig !== ns.lastSentJson) {
            ns.lastSentJson = sig;
            var patch = {};
            patch[peerPrefix + myId] = snap;
            sdk.rooms.setState(patch).catch(function(){});
          }
        }
      }
    };
    activeNetSyncs.push(ns);
    if (o.autoJoin !== false) ns.connect(typeof o.autoJoin === 'string' ? o.autoJoin : o.roomName);
    return ns;
  }

  function updateNetSyncs(dt) {
    for (var i = 0; i < activeNetSyncs.length; i++) {
      activeNetSyncs[i]._tick(dt);
    }
  }

  // --- Hybrid WebGL2 Post-FX Pipeline (+ Shockwaves, 1/4-res 2-Pass Bloom & Custom Shaders) ---
  var fxState = { enabled: false, bloom: 0, vignette: 0, chromatic: 0, wave: 0, blur: 0, contrast: 1, saturation: 1, crt: 0, customGlsl: '', customUniforms: {} };
  var glCanvas = null, gl = null, glLost = false, glRes = null;

  function shockwave(wx, wy, power, radius, dur) {
    var o = isOptsObj(wx) ? wx : {};
    var sx = isOptsObj(wx) ? (Number(o.x) || 0) : (Number(wx) || 0);
    var sy = isOptsObj(wx) ? (Number(o.y) || 0) : (Number(wy) || 0);
    var pwr = Number(isOptsObj(wx) ? (o.power !== undefined ? o.power : 0.04) : (power !== undefined ? power : 0.04));
    var rad = Math.max(24, Number(isOptsObj(wx) ? (o.radius || 240) : (radius || 240)));
    var rawD = Number(isOptsObj(wx) ? (o.dur || o.duration || 0.55) : (dur || 0.55));
    var dSec = Math.max(0.08, rawD > 10 ? rawD / 1000 : rawD);
    if (shockwaves.length >= 4) shockwaves.shift();
    shockwaves.push({ wx: sx, wy: sy, power: pwr, radius: rad, t: 0, dur: dSec });
  }

  function fx(opts) {
    if (opts === false || opts === null) { fxState.enabled = false; return; }
    if (opts === true) { fxState.enabled = true; return; }
    if (!opts || typeof opts !== 'object') return;
    fxState.enabled = true;
    if (opts.bloom !== undefined) fxState.bloom = Math.max(0, Math.min(2.5, Number(opts.bloom) || 0));
    if (opts.vignette !== undefined) fxState.vignette = Math.max(0, Math.min(1, Number(opts.vignette) || 0));
    if (opts.chromatic !== undefined) fxState.chromatic = Math.max(0, Math.min(10, Number(opts.chromatic) || 0));
    if (opts.wave !== undefined) fxState.wave = Math.max(0, Math.min(20, Number(opts.wave) || 0));
    if (opts.blur !== undefined) fxState.blur = Math.max(0, Math.min(10, Number(opts.blur) || 0));
    if (opts.contrast !== undefined) fxState.contrast = Math.max(0.2, Math.min(2.5, Number(opts.contrast) || 1));
    if (opts.saturation !== undefined) fxState.saturation = Math.max(0, Math.min(2.5, Number(opts.saturation) || 1));
    if (opts.crt !== undefined) fxState.crt = Math.max(0, Math.min(1, Number(opts.crt) || 0));
  }
  function setShader(glslCode, uniforms) {
    if (glslCode === null || glslCode === false) {
      fxState.customGlsl = '';
      if (glRes && glRes.customProg && gl) { gl.deleteProgram(glRes.customProg); glRes.customProg = null; }
      return;
    }
    var nextCode = String(glslCode || '');
    if (nextCode !== fxState.customGlsl) {
      fxState.customGlsl = nextCode;
      if (glRes) glRes.customSrcDirty = true;
    }
    fxState.customUniforms = (uniforms && typeof uniforms === 'object') ? uniforms : {};
    if (nextCode) fxState.enabled = true;
  }

  function compileGlProgram(ctxGl, vsSrc, fsSrc) {
    function makeSh(type, src) {
      var s = ctxGl.createShader(type);
      ctxGl.shaderSource(s, src);
      ctxGl.compileShader(s);
      if (!ctxGl.getShaderParameter(s, ctxGl.COMPILE_STATUS)) {
        var log = ctxGl.getShaderInfoLog(s) || 'Shader error';
        ctxGl.deleteShader(s);
        throw new Error(log);
      }
      return s;
    }
    var vs = makeSh(ctxGl.VERTEX_SHADER, vsSrc);
    var fs = makeSh(ctxGl.FRAGMENT_SHADER, fsSrc);
    var p = ctxGl.createProgram();
    ctxGl.attachShader(p, vs); ctxGl.attachShader(p, fs);
    ctxGl.linkProgram(p);
    ctxGl.deleteShader(vs); ctxGl.deleteShader(fs);
    if (!ctxGl.getProgramParameter(p, ctxGl.LINK_STATUS)) {
      var err = ctxGl.getProgramInfoLog(p) || 'Link error';
      ctxGl.deleteProgram(p);
      throw new Error(err);
    }
    return p;
  }

  function ensureWebGLPostFx() {
    if (glLost) return false;
    if (!glCanvas) {
      glCanvas = document.createElement('canvas');
      gl = glCanvas.getContext('webgl2', { alpha: true, premultipliedAlpha: false, antialias: false });
      if (!gl) { glLost = true; return false; }
      glCanvas.addEventListener('webglcontextlost', function(e) { e.preventDefault(); glLost = true; glRes = null; });
      glCanvas.addEventListener('webglcontextrestored', function() { glLost = false; glRes = null; });
    }
    if (!gl) { glLost = true; return false; }
    var cw = worldCanvas.width || 1, ch = worldCanvas.height || 1;
    if (glCanvas.width !== cw || glCanvas.height !== ch) { glCanvas.width = cw; glCanvas.height = ch; }
    if (!glRes) {
      try {
        var vsQuad = '#version 300 es\\nconst vec2 P[4]=vec2[](vec2(-1,-1),vec2(1,-1),vec2(-1,1),vec2(1,1));out vec2 v_uv;void main(){vec2 p=P[gl_VertexID];v_uv=p*0.5+0.5;gl_Position=vec4(p,0.0,1.0);}';
        var fsExtract = '#version 300 es\\nprecision mediump float;uniform sampler2D u_tex;in vec2 v_uv;out vec4 o;void main(){vec4 c=texture(u_tex,v_uv);float br=max(c.r,max(c.g,c.b));float k=smoothstep(0.55,0.95,br);o=vec4(c.rgb*k,1.0);}';
        var fsBlur = '#version 300 es\\nprecision mediump float;uniform sampler2D u_tex;uniform vec2 u_dir;in vec2 v_uv;out vec4 o;void main(){vec3 s=texture(u_tex,v_uv).rgb*0.227;s+=texture(u_tex,v_uv+u_dir*1.38).rgb*0.194;s+=texture(u_tex,v_uv-u_dir*1.38).rgb*0.194;s+=texture(u_tex,v_uv+u_dir*3.23).rgb*0.070;s+=texture(u_tex,v_uv-u_dir*3.23).rgb*0.070;o=vec4(s,1.0);}';
        var fsMain = '#version 300 es\\nprecision mediump float;uniform sampler2D u_tex,u_bloomTex;uniform vec2 u_resolution;uniform float u_time,u_bloom,u_vignette,u_chromatic,u_wave,u_blur,u_contrast,u_saturation,u_crt;uniform vec4 u_swPos[4];uniform float u_swAmp[4];in vec2 v_uv;out vec4 o;void main(){vec2 uv=v_uv;float asp=u_resolution.x/max(u_resolution.y,1.0);for(int i=0;i<4;i++){if(u_swAmp[i]>0.0001){vec2 df=uv-u_swPos[i].xy;vec2 da=vec2(df.x*asp,df.y);float dist=length(da);float rd=dist-u_swPos[i].z;float w=max(0.015,u_swPos[i].w);if(abs(rd)<w&&dist>0.0001){float f=1.0-abs(rd)/w;float disp=sin(rd*(3.14159/w))*u_swAmp[i]*(f*f);uv+=normalize(da)*disp*vec2(1.0/asp,1.0);}}}if(u_wave>0.0){uv.x+=sin(uv.y*28.0+u_time*4.5)*(u_wave*0.0012);uv.y+=cos(uv.x*22.0+u_time*3.8)*(u_wave*0.0008);}vec2 px=1.0/max(u_resolution,vec2(1.0));vec4 base=texture(u_tex,uv);if(u_chromatic>0.0){float sh=u_chromatic*px.x*2.0;base.r=texture(u_tex,uv+vec2(sh,0.0)).r;base.b=texture(u_tex,uv-vec2(sh,0.0)).b;}if(u_blur>0.0){vec2 b=u_blur*px*1.4;base.rgb=(base.rgb+texture(u_tex,uv+vec2(b.x,0.0)).rgb+texture(u_tex,uv-vec2(b.x,0.0)).rgb+texture(u_tex,uv+vec2(0.0,b.y)).rgb+texture(u_tex,uv-vec2(0.0,b.y)).rgb)*0.2;}vec3 col=base.rgb;if(u_bloom>0.0){col+=texture(u_bloomTex,uv).rgb*u_bloom;}col=(col-0.5)*u_contrast+0.5;float lum=dot(col,vec3(0.299,0.587,0.114));col=mix(vec3(lum),col,u_saturation);if(u_crt>0.0){float sc=0.88+0.12*sin(uv.y*u_resolution.y*1.6);col*=mix(1.0,sc,u_crt);}if(u_vignette>0.0){float d=distance(uv,vec2(0.5));col*=mix(1.0,smoothstep(0.95,0.28,d),u_vignette);}o=vec4(clamp(col,0.0,1.0),base.a);}';
        var makeTex = function() {
          var t = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D, t);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          return t;
        };
        glRes = {
          vsQuad: vsQuad,
          pExtract: compileGlProgram(gl, vsQuad, fsExtract),
          pBlur: compileGlProgram(gl, vsQuad, fsBlur),
          pMain: compileGlProgram(gl, vsQuad, fsMain),
          customProg: null, customSrcDirty: false,
          srcTex: makeTex(),
          bTexA: makeTex(), bFboA: gl.createFramebuffer(),
          bTexB: makeTex(), bFboB: gl.createFramebuffer(),
          bw: 0, bh: 0,
          vao: gl.createVertexArray()
        };
      } catch(err) {
        emitConsole('error', 'WebGL2 Post-FX отключён: ' + err.message);
        glLost = true;
        return false;
      }
    }
    var bw = Math.max(2, Math.floor(cw / 4)), bh = Math.max(2, Math.floor(ch / 4));
    if (glRes.bw !== bw || glRes.bh !== bh) {
      glRes.bw = bw; glRes.bh = bh;
      gl.bindTexture(gl.TEXTURE_2D, glRes.bTexA);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, bw, bh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, glRes.bFboA);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, glRes.bTexA, 0);
      gl.bindTexture(gl.TEXTURE_2D, glRes.bTexB);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, bw, bh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, glRes.bFboB);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, glRes.bTexB, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    if (fxState.customGlsl && glRes.customSrcDirty) {
      glRes.customSrcDirty = false;
      if (glRes.customProg) { gl.deleteProgram(glRes.customProg); glRes.customProg = null; }
      try {
        var rawSh = fxState.customGlsl;
        var fsCustom = rawSh.indexOf('#version') >= 0
          ? rawSh
          : '#version 300 es\\nprecision mediump float;uniform sampler2D u_tex;uniform vec2 u_resolution;uniform float u_time;in vec2 v_uv;out vec4 outColor;' +
            (rawSh.indexOf('void main') >= 0 ? rawSh : ('vec4 effect(sampler2D tex,vec2 uv,float time){\\n' + rawSh + '\\n}\\nvoid main(){outColor=effect(u_tex,v_uv,u_time);}'));
        glRes.customProg = compileGlProgram(gl, glRes.vsQuad, fsCustom);
      } catch(shErr) {
        emitConsole('error', 'Ошибка GLSL шейдера: ' + shErr.message);
        fxState.customGlsl = '';
      }
    }
    return true;
  }

  function runWebGLPostFx() {
    if ((!fxState.enabled && shockwaves.length === 0) || !ensureWebGLPostFx()) return false;
    var cw = glCanvas.width, ch = glCanvas.height;
    gl.bindVertexArray(glRes.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, glRes.srcTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, worldCanvas);

    if (fxState.enabled && fxState.bloom > 0) {
      gl.viewport(0, 0, glRes.bw, glRes.bh);
      gl.bindFramebuffer(gl.FRAMEBUFFER, glRes.bFboA);
      gl.useProgram(glRes.pExtract);
      gl.uniform1i(gl.getUniformLocation(glRes.pExtract, 'u_tex'), 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      gl.useProgram(glRes.pBlur);
      gl.uniform1i(gl.getUniformLocation(glRes.pBlur, 'u_tex'), 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, glRes.bFboB);
      gl.bindTexture(gl.TEXTURE_2D, glRes.bTexA);
      gl.uniform2f(gl.getUniformLocation(glRes.pBlur, 'u_dir'), 1.5 / glRes.bw, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      gl.bindFramebuffer(gl.FRAMEBUFFER, glRes.bFboA);
      gl.bindTexture(gl.TEXTURE_2D, glRes.bTexB);
      gl.uniform2f(gl.getUniformLocation(glRes.pBlur, 'u_dir'), 0, 1.5 / glRes.bh);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, cw, ch);
    var activeProg = (fxState.enabled && fxState.customGlsl && glRes.customProg) ? glRes.customProg : glRes.pMain;
    gl.useProgram(activeProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, glRes.srcTex);
    gl.uniform1i(gl.getUniformLocation(activeProg, 'u_tex'), 0);
    var locRes = gl.getUniformLocation(activeProg, 'u_resolution');
    if (locRes) gl.uniform2f(locRes, W, H);
    var locT = gl.getUniformLocation(activeProg, 'u_time');
    if (locT) gl.uniform1f(locT, gameTime);
    if (activeProg === glRes.pMain) {
      var fxOn = fxState.enabled;
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, glRes.bTexA);
      gl.uniform1i(gl.getUniformLocation(activeProg, 'u_bloomTex'), 1);
      gl.uniform1f(gl.getUniformLocation(activeProg, 'u_bloom'), fxOn ? fxState.bloom : 0);
      gl.uniform1f(gl.getUniformLocation(activeProg, 'u_vignette'), fxOn ? fxState.vignette : 0);
      gl.uniform1f(gl.getUniformLocation(activeProg, 'u_chromatic'), fxOn ? fxState.chromatic : 0);
      gl.uniform1f(gl.getUniformLocation(activeProg, 'u_wave'), fxOn ? fxState.wave : 0);
      gl.uniform1f(gl.getUniformLocation(activeProg, 'u_blur'), fxOn ? fxState.blur : 0);
      gl.uniform1f(gl.getUniformLocation(activeProg, 'u_contrast'), fxOn ? fxState.contrast : 1);
      gl.uniform1f(gl.getUniformLocation(activeProg, 'u_saturation'), fxOn ? fxState.saturation : 1);
      gl.uniform1f(gl.getUniformLocation(activeProg, 'u_crt'), fxOn ? fxState.crt : 0);
      var swPosArr = new Float32Array(16), swAmpArr = new Float32Array(4);
      var zc = cam.zoom || 1;
      for (var si = 0; si < Math.min(4, shockwaves.length); si++) {
        var sw = shockwaves[si];
        var progSw = Math.max(0, Math.min(1, sw.t / (sw.dur || 0.55)));
        var sx = (sw.wx - cam.x - W * 0.5) * zc + W * 0.5;
        var sy = (sw.wy - cam.y - H * 0.5) * zc + H * 0.5;
        swPosArr[si * 4] = sx / Math.max(1, W);
        swPosArr[si * 4 + 1] = 1.0 - (sy / Math.max(1, H));
        swPosArr[si * 4 + 2] = ((sw.radius * progSw) * zc) / Math.max(1, H);
        swPosArr[si * 4 + 3] = Math.max(0.03, ((sw.radius * 0.24) * zc) / Math.max(1, H));
        swAmpArr[si] = sw.power * (1.0 - progSw);
      }
      var lSwP = gl.getUniformLocation(activeProg, 'u_swPos');
      if (lSwP) gl.uniform4fv(lSwP, swPosArr);
      var lSwA = gl.getUniformLocation(activeProg, 'u_swAmp');
      if (lSwA) gl.uniform1fv(lSwA, swAmpArr);
    } else if (fxState.customUniforms) {
      Object.keys(fxState.customUniforms).forEach(function(uk) {
        var loc = gl.getUniformLocation(activeProg, uk);
        if (!loc) return;
        var uv = fxState.customUniforms[uk];
        if (Array.isArray(uv) && uv.length >= 2) gl.uniform2f(loc, Number(uv[0]) || 0, Number(uv[1]) || 0);
        else gl.uniform1f(loc, Number(uv) || 0);
      });
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return true;
  }

  var EASING = {
    linear: function(t) { return t; },
    easeIn: function(t) { return t * t; },
    easeOut: function(t) { return 1 - (1 - t) * (1 - t); },
    easeInOut: function(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; },
    bounce: function(t) { var n1 = 7.5625, d1 = 2.75; if (t < 1/d1) return n1*t*t; if (t < 2/d1) return n1*(t -= 1.5/d1)*t + 0.75; if (t < 2.5/d1) return n1*(t -= 2.25/d1)*t + 0.9375; return n1*(t -= 2.625/d1)*t + 0.984375; }
  };

  function addTween(obj, prop, toVal, durMs, easeName) {
    return new Promise(function(resolve) {
      if (!obj || typeof obj !== 'object') { resolve(obj); return; }
      var fromVal = Number(obj[prop]) || 0;
      var durSec = Math.max(0.016, (Number(durMs) || 300) / 1000);
      tweens.push({
        obj: obj, prop: prop, from: fromVal, to: Number(toVal) || 0,
        t: 0, dur: durSec, ease: EASING[easeName || 'easeOut'] || EASING.easeOut,
        scene: currentScene,
        resolve: resolve
      });
    });
  }

  function regSceneName(name) {
    var nm = String(name || '');
    if (nm && registeredScenes.indexOf(nm) < 0) registeredScenes.push(nm);
  }

  var inSceneScope = false;

  function resolveSceneOwner() {
    return (inSceneScope || sceneStack.length > 0 || currentScene !== 'main' || registeredScenes.length <= 1) ? currentScene : null;
  }

  function _isTaskDead(taskObj) {
    if (!taskObj) return false;
    if (!taskObj.alive) return true;
    if (taskObj.owner && taskObj.owner.alive === false) { taskObj.alive = false; return true; }
    return false;
  }

  function _runTask(owner, asyncFn) {
    var taskScene = resolveSceneOwner();
    var taskObj = {
      _royTask: true,
      owner: owner || null,
      scene: taskScene,
      alive: true,
      done: false,
      cancel: function() { taskObj.alive = false; }
    };
    activeTasks.push(taskObj);
    var p = Promise.resolve().then(function() {
      if (_isTaskDead(taskObj)) return;
      return asyncFn(taskObj);
    }).catch(function(err) {
      handleHookError(err);
    }).then(function(resVal) {
      taskObj.done = true;
      var idx = activeTasks.indexOf(taskObj);
      if (idx >= 0) activeTasks.splice(idx, 1);
      return resVal;
    });
    taskObj.then = function(onF, onR) { return p.then(onF, onR); };
    taskObj.catch = function(onR) { return p.catch(onR); };
    return taskObj;
  }

  function _taskWait(taskObj, msOrCond) {
    if (_isTaskDead(taskObj)) return Promise.resolve();
    var waiterScene = taskObj ? taskObj.scene : resolveSceneOwner();
    return new Promise(function(resolve) {
      if (typeof msOrCond === 'function') {
        taskWaiters.push({ task: taskObj, kind: 'cond', fn: msOrCond, resolve: resolve, scene: waiterScene });
      } else if (msOrCond === undefined) {
        taskWaiters.push({ task: taskObj, kind: 'frames', frames: 1, resolve: resolve, scene: waiterScene });
      } else {
        var ms = Number(msOrCond) || 0;
        if (ms <= 0) {
          taskWaiters.push({ task: taskObj, kind: 'frames', frames: 1, resolve: resolve, scene: waiterScene });
        } else {
          taskWaiters.push({ task: taskObj, kind: 'time', rem: ms / 1000, resolve: resolve, scene: waiterScene });
        }
      }
    });
  }

  function spawnTask(fnOrHandle, owner) {
    if (fnOrHandle && fnOrHandle._royTask) {
      if (owner) fnOrHandle.owner = owner;
      return fnOrHandle;
    }
    if (typeof fnOrHandle === 'function') {
      return _runTask(owner || null, fnOrHandle);
    }
    return null;
  }

  function cancelTasks(owner) {
    for (var i = activeTasks.length - 1; i >= 0; i--) {
      var t = activeTasks[i];
      if (!owner || t === owner || t.owner === owner) {
        t.alive = false;
        activeTasks.splice(i, 1);
      }
    }
    for (var wi = taskWaiters.length - 1; wi >= 0; wi--) {
      var w = taskWaiters[wi];
      if (!owner || (w.task && (w.task === owner || w.task.owner === owner || !w.task.alive))) {
        taskWaiters.splice(wi, 1);
        try { w.resolve(); } catch(e) {}
      }
    }
  }

  function cleanupSceneArtifacts(scName) {
    timers = timers.filter(function(t) { return t.scene !== scName; });
    afterTimers = afterTimers.filter(function(t) { return t.scene !== scName; });
    tweens = tweens.filter(function(tw) {
      if (tw.scene === scName) { try { tw.resolve(tw.obj); } catch(e) {} return false; }
      return true;
    });
    for (var i = activeTasks.length - 1; i >= 0; i--) {
      if (activeTasks[i].scene === scName) {
        activeTasks[i].alive = false;
        activeTasks.splice(i, 1);
      }
    }
    for (var wi = taskWaiters.length - 1; wi >= 0; wi--) {
      if (taskWaiters[wi].scene === scName) {
        var wr = taskWaiters.splice(wi, 1)[0];
        try { wr.resolve(); } catch(e) {}
      }
    }
    for (var ei = 0; ei < worldEntities.length; ei++) {
      if (worldEntities[ei] && worldEntities[ei]._scene === scName) worldEntities[ei].alive = false;
    }
  }

  function applySceneSwitchNow(nxt, payload) {
    var old = currentScene;
    regSceneName(nxt);
    while (sceneStack.length > 0) {
      var st = sceneStack.pop();
      if (st && st.name && st.name !== nxt) {
        cleanupSceneArtifacts(st.name);
        if (sceneHooks['exit:' + st.name]) {
          sceneHooks['exit:' + st.name].forEach(function(fn) {
            __rt._loopTicks = 0;
            Promise.resolve(fn(payload)).catch(handleHookError);
          });
        }
      }
    }
    if (old !== nxt) {
      cleanupSceneArtifacts(old);
      if (sceneHooks['exit:' + old]) {
        sceneHooks['exit:' + old].forEach(function(fn) {
          __rt._loopTicks = 0;
          Promise.resolve(fn(payload)).catch(handleHookError);
        });
      }
    }
    currentScene = nxt;
    sceneTime = 0;
    sceneFrame = 0;
    if (sceneHooks['enter:' + nxt]) {
      inSceneScope = true;
      try {
        sceneHooks['enter:' + nxt].forEach(function(fn) {
          __rt._loopTicks = 0;
          Promise.resolve(fn(payload)).catch(handleHookError);
        });
      } finally { inSceneScope = false; }
    }
  }

  function gotoScene(nextName, payload, opts) {
    var nxt = String(nextName || 'main');
    var trOpts = isOptsObj(payload) && opts === undefined && (payload.transition || payload.dur || payload.color) ? payload : opts;
    var actualPayload = trOpts === payload ? undefined : payload;
    if (isOptsObj(trOpts) && trOpts.transition) {
      var rawD = Number(trOpts.dur !== undefined ? trOpts.dur : (trOpts.duration || 400));
      var dSec = Math.max(0.08, rawD > 10 ? rawD / 1000 : rawD);
      transitionState.active = true;
      transitionState.kind = String(trOpts.transition || 'fade').toLowerCase();
      transitionState.color = trOpts.color || '#000000';
      transitionState.dur = dSec;
      transitionState.elapsed = 0;
      transitionState.switched = false;
      transitionState.target = nxt;
      transitionState.payload = actualPayload;
      return;
    }
    applySceneSwitchNow(nxt, actualPayload);
  }

  function pushScene(nextName, payload, opts) {
    var nxt = String(nextName || 'main');
    var stOpts = isOptsObj(payload) && opts === undefined && (payload.dim !== undefined || payload.blur !== undefined || payload.draw !== undefined) ? payload : opts;
    var actualPayload = stOpts === payload ? undefined : payload;
    var o = isOptsObj(stOpts) ? stOpts : {};
    regSceneName(nxt);
    var snap = document.createElement('canvas');
    snap.width = canvas.width || 1;
    snap.height = canvas.height || 1;
    var sctx = snap.getContext('2d');
    try { sctx.drawImage(worldCanvas, 0, 0); } catch(e) {}
    sceneStack.push({
      name: currentScene,
      sceneTime: sceneTime,
      sceneFrame: sceneFrame,
      snapCanvas: snap,
      dim: o.dim !== undefined ? Math.max(0, Math.min(0.95, Number(o.dim))) : 0.45,
      blur: o.blur !== undefined ? Math.max(0, Math.min(16, Number(o.blur))) : 0
    });
    currentScene = nxt;
    sceneTime = 0;
    sceneFrame = 0;
    if (sceneHooks['enter:' + nxt]) {
      inSceneScope = true;
      try {
        sceneHooks['enter:' + nxt].forEach(function(fn) {
          __rt._loopTicks = 0;
          Promise.resolve(fn(actualPayload)).catch(handleHookError);
        });
      } finally { inSceneScope = false; }
    }
  }

  function popScene(result) {
    if (sceneStack.length === 0) return null;
    var old = currentScene;
    cleanupSceneArtifacts(old);
    if (sceneHooks['exit:' + old]) {
      sceneHooks['exit:' + old].forEach(function(fn) {
        __rt._loopTicks = 0;
        Promise.resolve(fn(result)).catch(handleHookError);
      });
    }
    var prev = sceneStack.pop();
    currentScene = prev.name;
    sceneTime = prev.sceneTime;
    sceneFrame = prev.sceneFrame;
    if (sceneHooks['resume:' + currentScene]) {
      inSceneScope = true;
      try {
        sceneHooks['resume:' + currentScene].forEach(function(fn) {
          __rt._loopTicks = 0;
          Promise.resolve(fn(result)).catch(handleHookError);
        });
      } finally { inSceneScope = false; }
    }
    return currentScene;
  }

  function drawEntitiesNow(filterTag) {
    entitiesDrawnThisFrame = true;
    for (var i = 0; i < worldEntities.length; i++) {
      var ent = worldEntities[i];
      if (!ent || ent.alive === false) continue;
      if (ent._scene && ent._scene !== currentScene) continue;
      if (filterTag && ent.tag !== filterTag) continue;
      if (typeof ent.draw === 'function') ent.draw();
    }
  }

  var sdk = window.RoySDK || {
    player: { getSync: function(){ return { username: 'Гость', displayName: 'Гость', isGuest: true }; }, get: function(){ return Promise.resolve({ username: 'Гость', isGuest: true }); } },
    storage: { get: function(k, d){ return Promise.resolve(d); }, set: function(){ return Promise.resolve(true); }, remove: function(){ return Promise.resolve(true); }, getAll: function(){ return Promise.resolve({}); } },
    leaderboard: { submit: function(){ return Promise.resolve({ saved: false }); }, getTop: function(){ return Promise.resolve([]); } },
    world: { get: function(){ return Promise.resolve(null); }, set: function(){ return Promise.resolve(true); }, update: function(){ return Promise.resolve(true); }, push: function(){ return Promise.resolve('0'); }, subscribe: function(){ return function(){}; }, subscribeAdded: function(){ return function(){}; } },
    rooms: { list: function(){ return Promise.resolve([]); }, create: function(){ return Promise.resolve({}); }, join: function(){ return Promise.resolve({}); }, leave: function(){ return Promise.resolve(true); }, getState: function(){ return Promise.resolve({}); }, setState: function(){ return Promise.resolve(true); }, sendEvent: function(){ return Promise.resolve(true); }, onState: function(){ return function(){}; }, onPlayers: function(){ return function(){}; }, onEvent: function(){ return function(){}; } },
    ui: { toast: function(){}, openDonate: function(){}, setTitleBadge: function(){} }
  };

  var gameObj = {
    get width() { return W; },
    get height() { return H; },
    get dpr() { return DPR; },
    bg: BG,
    get time() { return gameTime; },
    get fps() { return currentFps; },
    clear: function(c) {
      ctx.save();
      if (ctx === frameBaseCtx || ctx === rootCtx) ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.fillStyle = c || gameObj.bg;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
  };

  var sceneObj = {
    get name() { return currentScene; },
    get time() { return sceneTime; },
    get frame() { return sceneFrame; },
    get depth() { return sceneStack.length; },
    is: function(n) { return currentScene === n; },
    goto: gotoScene,
    push: pushScene,
    pop: popScene
  };

  var __rt = {
    _assets: {},
    _loc: '',
    _loopTicks: 0,
    _regScene: regSceneName,
    _runTask: _runTask,
    _taskWait: _taskWait,
    _isTaskDead: _isTaskDead,
    BaseEntity: BaseEntity,
    spawn: function(ent) {
      if (ent && typeof ent === 'object') {
        if (ent.alive === undefined) ent.alive = true;
        if (ent._scene === undefined || ent._scene === null) ent._scene = resolveSceneOwner();
        worldEntities.push(ent);
      }
      return ent;
    },
    entities: function(tagName) {
      return worldEntities.filter(function(e) { return e && e.alive !== false && (!e._scene || e._scene === currentScene) && (!tagName || e.tag === tagName); });
    },
    destroyAll: function(tagName) {
      worldEntities.forEach(function(e) { if (e && (!tagName || e.tag === tagName)) e.alive = false; });
    },
    drawEntities: drawEntitiesNow,
    on: function(ev, fn) {
      var evStr = String(ev);
      if (evStr.indexOf('enter:') === 0 || evStr.indexOf('exit:') === 0 || evStr.indexOf('resume:') === 0) {
        if (!sceneHooks[evStr]) sceneHooks[evStr] = [];
        sceneHooks[evStr].push(fn);
      } else if (hooks[evStr]) {
        hooks[evStr].push(fn);
      }
    },
    every: function(ms, fn, ownerEnt) {
      var scOwner = resolveSceneOwner();
      timers.push({ interval: Math.max(0.016, (Number(ms) || 1000) / 1000), acc: 0, fn: fn, scene: scOwner, owner: ownerEnt || null });
    },
    after: function(ms, fn, ownerEnt) {
      var scOwner = resolveSceneOwner();
      afterTimers.push({ rem: Math.max(0.001, (Number(ms) || 0) / 1000), fn: fn, scene: scOwner, owner: ownerEnt || null });
    },
    wait: function(msOrCond) { return _taskWait(null, msOrCond); },
    spawnTask: spawnTask,
    cancelTasks: cancelTasks,
    setState: setStateGlobal,
    loadImage: function(p) { return loadImageAsset(p); },
    loadSound: function(p) { return loadSoundAsset(p); },
    loadJson: function(p) { return loadJsonAsset(p); },
    tilemap: tilemap,
    tileMask: tileMask,
    panel9: panel9,
    moveAndCollide: moveAndCollide,
    moveCircle: moveCircle,
    raycast: raycast,
    lineOfSight: lineOfSight,
    bounceCircle: bounceCircle,
    spatialQuery: spatialQuery,
    steerSeek: steerSeek,
    steerArrive: steerArrive,
    steerSeparate: steerSeparate,
    button: button,
    panel: panel,
    hovered: hovered,
    vbox: vbox,
    hbox: hbox,
    layoutEnd: layoutEnd,
    scrollView: scrollView,
    uiButton: uiButton,
    uiLabel: uiLabel,
    uiPanel: uiPanel,
    setLocale: setLocale,
    getLocale: getLocale,
    addTranslations: addTranslations,
    t: t,
    scrollBegin: scrollBegin,
    scrollEnd: scrollEnd,
    slider: slider,
    toggle: toggle,
    pathfind: pathfindGrid,
    pathfindAsync: pathfindAsync,
    flowField: flowField,
    drawGradient: drawGradient,
    drawRadialGradient: drawRadialGradient,
    layer: createLayer,
    beginScreen: beginScreenSpace,
    beginWorld: beginWorldSpace,
    zoomAt: zoomAt,
    pushMatrix: function() { ctx.save(); },
    popMatrix: function() { ctx.restore(); },
    translate: function(x, y) { ctx.translate(Number(x) || 0, Number(y) || 0); },
    rotate: function(rad) { ctx.rotate(Number(rad) || 0); },
    scale: function(sx, sy) { var x0 = sx === undefined ? 1 : Number(sx); ctx.scale(x0, sy === undefined ? x0 : Number(sy)); },
    clip: function(x, y, w, h) { ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip(); },
    unclip: function() { ctx.restore(); },
    consumeClick: function() { mouse.clicked = false; mouse.rightClicked = false; },
    setCursor: function(c) { canvas.style.cursor = c || 'default'; },
    setGamepad: function(opts) {
      try {
        var payload = typeof opts === 'boolean' ? { visible: opts } : (opts || {});
        window.parent.postMessage({ type: 'roy-gamepad-config', visible: payload.visible, wasd: payload.wasd, extras: payload.extras, stick: payload.stick }, '*');
      } catch(e) {}
    },
    vibrate: function(ms) {
      try { if (navigator && typeof navigator.vibrate === 'function') navigator.vibrate(ms || 30); } catch(e) {}
    },
    gamepad: function(idx) {
      var gi = Number(idx) || 0;
      if (gi === 0) {
        return {
          connected: hwPadState.connected, id: hwPadState.id,
          lx: hwPadState.lx, ly: hwPadState.ly, rx: hwPadState.rx, ry: hwPadState.ry,
          lt: hwPadState.lt, rt: hwPadState.rt,
          button: function(nm) { return !!hwPadState.btns[nm]; },
          buttonPressed: function(nm) { return !!hwPadState.justPressed[nm]; },
          rumble: function(w, s, ms) { return __rt.rumble(w, s, ms); }
        };
      }
      var list = (navigator && navigator.getGamepads) ? navigator.getGamepads() : [];
      var gp = list && list[gi];
      return gp ? { connected: !!gp.connected, id: gp.id || '', lx: gp.axes[0] || 0, ly: gp.axes[1] || 0, rx: gp.axes[2] || 0, ry: gp.axes[3] || 0 } : { connected: false, lx: 0, ly: 0, rx: 0, ry: 0 };
    },
    rumble: function(weakMag, strongMag, durMs) {
      try {
        var list = (navigator && navigator.getGamepads) ? navigator.getGamepads() : [];
        var gp = list && list[0];
        if (gp && gp.vibrationActuator && typeof gp.vibrationActuator.playEffect === 'function') {
          gp.vibrationActuator.playEffect('dual-rumble', {
            startDelay: 0,
            duration: Math.max(20, Math.min(2000, Number(durMs) || 160)),
            weakMagnitude: Math.max(0, Math.min(1, weakMag === undefined ? 0.5 : Number(weakMag))),
            strongMagnitude: Math.max(0, Math.min(1, strongMag === undefined ? 0.7 : Number(strongMag)))
          }).catch(function(){});
          return true;
        }
      } catch(e) {}
      try { if (navigator && typeof navigator.vibrate === 'function') navigator.vibrate(durMs || 60); } catch(e) {}
      return false;
    },
    bind: function(actionName, keysOrArr) {
      var nm = String(actionName || '');
      if (!nm) return;
      actionBindings[nm] = Array.isArray(keysOrArr) ? keysOrArr.slice() : [String(keysOrArr || '')];
    },
    unbind: function(actionName) { delete actionBindings[String(actionName || '')]; },
    action: function(actionName) {
      var list = actionBindings[String(actionName || '')];
      if (!list) return false;
      for (var i = 0; i < list.length; i++) {
        var tok = String(list[i]);
        if (tok === 'MouseLeft' || tok === 'mouseLeft') { if (mouse.down) return true; }
        else if (tok === 'MouseRight' || tok === 'mouseRight') { if (mouse.rightDown) return true; }
        else if (__rt.key(tok)) return true;
      }
      return false;
    },
    actionPressed: function(actionName) {
      var list = actionBindings[String(actionName || '')];
      if (!list) return false;
      for (var i = 0; i < list.length; i++) {
        var tok = String(list[i]);
        if (tok === 'MouseLeft' || tok === 'mouseLeft') { if (mouse.clicked) return true; }
        else if (tok === 'MouseRight' || tok === 'mouseRight') { if (mouse.rightClicked) return true; }
        else if (__rt.keyPressed(tok)) return true;
      }
      return false;
    },
    actionReleased: function(actionName) {
      var list = actionBindings[String(actionName || '')];
      if (!list) return false;
      for (var i = 0; i < list.length; i++) {
        var tok = String(list[i]);
        if (tok === 'MouseLeft' || tok === 'mouseLeft') { if (mouse.justReleased) return true; }
        else if (keysJustReleased[tok] || keysJustReleased[tok.toLowerCase()]) return true;
      }
      return false;
    },
    lockPointer: function() { try { if (canvas && canvas.requestPointerLock) canvas.requestPointerLock(); } catch(e) {} },
    unlockPointer: function() { try { if (document && document.exitPointerLock) document.exitPointerLock(); } catch(e) {} },
    pointerLocked: function() { try { return document.pointerLockElement === canvas; } catch(e) { return false; } },
    gesture: function() { return { swipe: gestureState.swipe, pinch: gestureState.pinch, pinchScale: gestureState.pinchScale, pinchCx: gestureState.pinchCx, pinchCy: gestureState.pinchCy, doubleTap: gestureState.doubleTap }; },
    swipe: function() { return gestureState.swipe; },
    pinchZoom: function() { return gestureState.pinch; },
    doubleTap: function() { return gestureState.doubleTap; },
    freezeFrame: function(ms) { var d = Number(ms) || 60; freezeRem = Math.max(freezeRem, d > 10 ? d / 1000 : d); },
    hitStop: function(ms) { var d = Number(ms) || 60; freezeRem = Math.max(freezeRem, d > 10 ? d / 1000 : d); },
    flashScreen: function(col, ms) { var d = Number(ms) || 180; flashState.color = col || '#ffffff'; flashState.dur = d > 10 ? d / 1000 : d; flashState.rem = flashState.dur; },
    timeScale: function(s) {
      if (s === undefined) return gameplayTimeScale;
      gameplayTimeScale = Math.max(0, Math.min(4, Number(s)));
      return gameplayTimeScale;
    },
    fx: fx,
    setShader: setShader,
    shockwave: shockwave,
    weather: weather,
    waterZone: waterZone,
    ambientLight: ambientLight,
    light: light,
    shadowLight: shadowLight,
    coneLight: coneLight,
    shadowCasters: shadowCasters,
    setBlend: function(mode) { ctx.globalCompositeOperation = mode || 'source-over'; },
    setShadow: function(blur, col, ox, oy) {
      ctx.shadowBlur = Number(blur) || 0;
      ctx.shadowColor = col || 'rgba(0,0,0,0.6)';
      ctx.shadowOffsetX = Number(ox) || 0;
      ctx.shadowOffsetY = Number(oy) || 0;
    },
    resetShadow: function() { ctx.shadowBlur = 0; ctx.shadowColor = 'transparent'; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0; },
    drawTrail: drawTrail,
    ropeChain: ropeChain,
    limbIK: limbIK,
    debug: function(flag) {
      debugOverlay = flag === undefined ? !debugOverlay : !!flag;
      return debugOverlay;
    },
    scene: sceneObj,
    goto: gotoScene,
    pushScene: pushScene,
    popScene: popScene,
    tween: addTween,
    vec: vec,
    sprite: sprite,
    anim: anim,
    pool: pool,
    fogOfWar: fogOfWar,
    ragdoll: ragdoll,
    game: gameObj,
    mouse: mouse,
    touches: touches,
    player: sdk.player.getSync(),
    RoySDK: sdk,
    world: sdk.world,
    rooms: sdk.rooms,
    netSync: netSync,
    dialogue: dialogue,
    uiGrid: uiGrid,
    tooltip: tooltip,
    ghostRecord: ghostRecord,
    ghostStop: ghostStop,
    ghostPlay: ghostPlay,
    save: function(k, v) { return sdk.storage.set(k, v); },
    load: function(k, d) { return sdk.storage.get(k, d); },
    submitScore: function(sc, opts) { return sdk.leaderboard.submit(sc, opts || { mode: 'best' }); },
    topScores: function(lim) { return sdk.leaderboard.getTop(lim || 15); },
    toast: showToast,
    openDonate: function() { return sdk.ui.openDonate(); },
    setBadge: function(txt) { return sdk.ui.setTitleBadge(txt); },
    cls: function(c) { gameObj.clear(c); },
    clear: function(c) { gameObj.clear(c); },
    rect: makeRectEntity,
    circle: makeCircleEntity,
    drawObj: function(o) { if (o && typeof o.draw === 'function') o.draw(); },
    drawRect: drawRect,
    strokeRect: strokeRect,
    drawCircle: drawCircle,
    strokeCircle: strokeCircle,
    drawArc: drawArc,
    drawRing: drawRing,
    drawEllipse: drawEllipse,
    drawLine: drawLine,
    drawPoly: drawPoly,
    drawPath: drawPath,
    drawCurve: drawCurve,
    drawBezier: drawBezier,
    drawStar: drawStar,
    drawBar: drawBar,
    drawGrid: drawGrid,
    pixel: function(x, y, size, color) { drawRect(x, y, size || 10, size || 10, color); },
    setFont: function(f) { fontFamily = f || 'system-ui, -apple-system, sans-serif'; },
    text: text,
    textStroke: textStroke,
    textWrap: textWrap,
    measureText: measureTextBox,
    glow: function(col, blur) { ctx.shadowColor = col || '#38bdf8'; ctx.shadowBlur = Number(blur) || 14; },
    resetGlow: function() { ctx.shadowBlur = 0; ctx.shadowColor = 'transparent'; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0; },
    alpha: function(a) { ctx.globalAlpha = Math.max(0, Math.min(1, Number(a))); },
    blend: function(mode) { ctx.globalCompositeOperation = mode || 'source-over'; },
    particles: spawnParticles,
    emitParticles: spawnParticles,
    camera: function(x, y, zoom) { cam.x = Number(x) || 0; cam.y = Number(y) || 0; cam.zoom = Number(zoom) || 1; cam.followTarget = null; },
    getCamera: getCamera,
    camX: camX,
    camY: camY,
    camZoom: camZoom,
    inView: inView,
    cameraFollow: function(target, smooth) { cam.followTarget = target || null; if (smooth !== undefined) cam.followSmooth = Number(smooth) || 8; },
    cameraBounds: function(minX, minY, maxX, maxY) {
      if (minX === null || minX === undefined) { cam.bounds = null; return; }
      cam.bounds = { minX: Number(minX) || 0, minY: Number(minY) || 0, maxX: Number(maxX) || W, maxY: Number(maxY) || H };
    },
    shake: function(power, durMs) { cam.shakePow = Math.max(cam.shakePow, Number(power) || 8); var d = Number(durMs) || 250; cam.shakeDur = d > 10 ? d / 1000 : d; cam.shakeTime = cam.shakeDur; },
    key: function(code) { return !!keysDown[code] || !!keysDown[String(code).toLowerCase()]; },
    keyPressed: function(code) { return !!keysJustPressed[code] || !!keysJustPressed[String(code).toLowerCase()]; },
    axis: function(dir) {
      var d = String(dir || 'horizontal').toLowerCase();
      if (d === 'x' || d === 'horizontal' || d === 'h') {
        var l = keysDown['ArrowLeft'] || keysDown['KeyA'] || keysDown['a'] || keysDown['PadLeft'];
        var r = keysDown['ArrowRight'] || keysDown['KeyD'] || keysDown['d'] || keysDown['PadRight'];
        var kv = (r ? 1 : 0) - (l ? 1 : 0);
        if (kv !== 0) return kv;
        if (hwPadState.connected && Math.abs(hwPadState.lx) > 0.01) return hwPadState.lx;
        return (virtualAxis.active && Math.abs(virtualAxis.x) > 0.02) ? virtualAxis.x : 0;
      }
      var u = keysDown['ArrowUp'] || keysDown['KeyW'] || keysDown['w'] || keysDown['PadUp'];
      var dn = keysDown['ArrowDown'] || keysDown['KeyS'] || keysDown['s'] || keysDown['PadDown'];
      var ky = (dn ? 1 : 0) - (u ? 1 : 0);
      if (ky !== 0) return ky;
      if (hwPadState.connected && Math.abs(hwPadState.ly) > 0.01) return hwPadState.ly;
      return (virtualAxis.active && Math.abs(virtualAxis.y) > 0.02) ? virtualAxis.y : 0;
    },
    sfx: sfx,
    synth: synth,
    tone: tone,
    playNote: tone,
    melody: melody,
    bgm: bgm,
    syncBgm: syncBgm,
    stopBgm: stopBgm,
    setReverb: setReverb,
    setMuted: setMuted,
    isMuted: function() { return audioMuted || tabMuted; },
    now: function() { return Date.now(); },
    abs: Math.abs, min: Math.min, max: Math.max,
    clamp: function(v, a, b) { return Math.max(a, Math.min(b, v)); },
    lerp: function(a, b, t) { return a + (b - a) * t; },
    wrap: function(v, mn, mx) { var span = (mx - mn) || 1; return ((((v - mn) % span) + span) % span) + mn; },
    sign: function(v) { return v > 0 ? 1 : (v < 0 ? -1 : 0); },
    approach: function(cur, target, step) { var s = Math.abs(Number(step) || 0); return cur < target ? Math.min(target, cur + s) : Math.max(target, cur - s); },
    range: function(a, b, step) {
      var out = [], st = step === undefined ? (a <= b ? 1 : -1) : Number(step);
      if (!st) return out;
      for (var i = a; st > 0 ? i < b : i > b; i += st) { out.push(i); if (out.length > 50000) break; }
      return out;
    },
    sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
    sqrt: Math.sqrt, pow: Math.pow, floor: Math.floor, ceil: Math.ceil, round: Math.round,
    log10: Math.log10, exp: Math.exp, PI: Math.PI, TAU: Math.PI * 2,
    noise2d: noise2d, fbm: fbm, hsl: hsl, lerpColor: lerpColor,
    roundTo: function(v, d) { var f = Math.pow(10, Number(d) || 0); return Math.round((Number(v) || 0) * f) / f; },
    fmtNum: function(v) { return Math.round(Number(v) || 0).toString().replace(/\\B(?=(\\d{3})+(?!\\d))/g, ' '); },
    int: function(v) { return parseInt(v, 10) || 0; },
    float: function(v) { return parseFloat(v) || 0; },
    num: function(v) { return Number(v) || 0; },
    bool: function(v) { return Boolean(v); },
    str: function(v) { return String(v === undefined || v === null ? '' : v); },
    rand: function(a, b) { if (b === undefined) { b = a === undefined ? 1 : a; a = 0; } return a + Math.random() * (b - a); },
    randInt: function(a, b) { if (b === undefined) { b = a; a = 0; } return Math.floor(a + Math.random() * (b - a + 1)); },
    random: function(a, b) {
      if (a === undefined) return Math.random();
      if (b === undefined) return Math.random() * Number(a);
      var lo = Number(a) || 0, hi = Number(b) || 0;
      return lo + Math.random() * (hi - lo);
    },
    choose: function(arr) { return Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : null; },
    len: function(v) { if (Array.isArray(v) || typeof v === 'string') return v.length; if (v && typeof v === 'object') return Object.keys(v).length; return 0; },
    push: function(arr, v) { if (Array.isArray(arr)) arr.push(v); return arr; },
    pop: function(arr) { return Array.isArray(arr) ? arr.pop() : null; },
    removeAt: function(arr, idx) { if (Array.isArray(arr) && idx >= 0 && idx < arr.length) return arr.splice(idx, 1)[0]; return null; },
    map: function(arr, fn) { return Array.isArray(arr) && typeof fn === 'function' ? arr.map(fn) : []; },
    filter: function(arr, fn) { return Array.isArray(arr) && typeof fn === 'function' ? arr.filter(fn) : []; },
    find: function(arr, fn) { return Array.isArray(arr) && typeof fn === 'function' ? (arr.find(fn) ?? null) : null; },
    some: function(arr, fn) { return Array.isArray(arr) && typeof fn === 'function' ? arr.some(fn) : false; },
    everyItem: function(arr, fn) { return Array.isArray(arr) && typeof fn === 'function' ? arr.every(fn) : false; },
    reduce: function(arr, fn, init) { return Array.isArray(arr) && typeof fn === 'function' ? (init !== undefined ? arr.reduce(fn, init) : arr.reduce(fn)) : init; },
    sort: function(arr, fn) { if (!Array.isArray(arr)) return []; var cp = arr.slice(); return typeof fn === 'function' ? cp.sort(fn) : cp.sort(function(a, b){ return a > b ? 1 : (a < b ? -1 : 0); }); },
    slice: function(v, a, b) { return (Array.isArray(v) || typeof v === 'string') ? v.slice(a, b) : []; },
    reverse: function(arr) { return Array.isArray(arr) ? arr.slice().reverse() : []; },
    contains: function(col, val) { return Array.isArray(col) || typeof col === 'string' ? col.indexOf(val) >= 0 : false; },
    indexOf: function(col, val) { return Array.isArray(col) || typeof col === 'string' ? col.indexOf(val) : -1; },
    flat: function(arr, d) { return Array.isArray(arr) ? arr.flat(d === undefined ? 1 : d) : []; },
    split: function(s, sep) { return String(s === undefined || s === null ? '' : s).split(sep === undefined ? '' : sep); },
    join: function(arr, sep) { return Array.isArray(arr) ? arr.join(sep === undefined ? ',' : sep) : ''; },
    trim: function(s) { return String(s === undefined || s === null ? '' : s).trim(); },
    upper: function(s) { return String(s === undefined || s === null ? '' : s).toUpperCase(); },
    lower: function(s) { return String(s === undefined || s === null ? '' : s).toLowerCase(); },
    replace: function(s, a, b) { return String(s === undefined || s === null ? '' : s).split(String(a)).join(String(b === undefined ? '' : b)); },
    keys: function(o) { return o && typeof o === 'object' ? Object.keys(o) : []; },
    values: function(o) { return o && typeof o === 'object' ? Object.values(o) : []; },
    dist: function(x1, y1, x2, y2) { return Math.hypot((x2 || 0) - (x1 || 0), (y2 || 0) - (y1 || 0)); },
    collides: collides,
    print: function() { emitConsole('info', Array.prototype.slice.call(arguments).map(function(a){ return typeof a === 'object' ? JSON.stringify(a) : String(a); }).join(' ')); },
    log: function() { emitConsole('info', Array.prototype.slice.call(arguments).map(function(a){ return typeof a === 'object' ? JSON.stringify(a) : String(a); }).join(' ')); }
  };

  function canvasCoords(e) {
    var r = canvas.getBoundingClientRect();
    var sx = ((e.clientX - r.left) / (r.width || 1)) * W;
    var sy = ((e.clientY - r.top) / (r.height || 1)) * H;
    var wx = (sx - W / 2) / (cam.zoom || 1) + W / 2 + cam.x;
    var wy = (sy - H / 2) / (cam.zoom || 1) + H / 2 + cam.y;
    return { x: sx, y: sy, rx: wx, ry: wy, wx: wx, wy: wy };
  }

  function updateTouchesList(touchList) {
    touches.length = 0;
    for (var i = 0; i < touchList.length; i++) {
      var p = canvasCoords(touchList[i]);
      touches.push({ id: touchList[i].identifier, x: p.x, y: p.y, wx: p.wx, wy: p.wy });
    }
  }

  window.addEventListener('message', function(e) {
    var d = e && e.data;
    if (!d) return;
    if (d.type === 'roy-virtual-axis') {
      virtualAxis.x = Math.max(-1, Math.min(1, Number(d.x) || 0));
      virtualAxis.y = Math.max(-1, Math.min(1, Number(d.y) || 0));
      virtualAxis.active = !!d.active;
      return;
    }
    if (d.type !== 'roy-virtual-key') return;
    var code = String(d.code || '');
    var k = String(d.key || code);
    if (d.pressed) {
      if (!keysDown[code]) { keysJustPressed[code] = true; keysJustPressed[k.toLowerCase()] = true; }
      keysDown[code] = true; keysDown[k] = true; keysDown[k.toLowerCase()] = true;
      hooks.keydown.forEach(function(fn) { __rt._loopTicks = 0; Promise.resolve(fn(k)).catch(handleHookError); });
    } else {
      delete keysDown[code]; delete keysDown[k]; delete keysDown[k.toLowerCase()];
      hooks.keyup.forEach(function(fn) { __rt._loopTicks = 0; Promise.resolve(fn(k)).catch(handleHookError); });
    }
  });

  window.addEventListener('keydown', function(e) {
    if (e.key === 'F3' || e.code === 'F3') {
      e.preventDefault();
      debugOverlay = !debugOverlay;
      return;
    }
    if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space',' '].indexOf(e.key) >= 0) e.preventDefault();
    if (dialogueHandleKey(e)) return;
    if (!keysDown[e.code]) { keysJustPressed[e.code] = true; keysJustPressed[e.key.toLowerCase()] = true; }
    keysDown[e.code] = true; keysDown[e.key] = true; keysDown[e.key.toLowerCase()] = true;
    hooks.keydown.forEach(function(fn) { __rt._loopTicks = 0; Promise.resolve(fn(e.key)).catch(handleHookError); });
  });

  window.addEventListener('keyup', function(e) {
    keysJustReleased[e.code] = true; keysJustReleased[e.key] = true; keysJustReleased[e.key.toLowerCase()] = true;
    delete keysDown[e.code]; delete keysDown[e.key]; delete keysDown[e.key.toLowerCase()];
    hooks.keyup.forEach(function(fn) { __rt._loopTicks = 0; Promise.resolve(fn(e.key)).catch(handleHookError); });
  });

  canvas.addEventListener('contextmenu', function(e) { e.preventDefault(); });

  canvas.addEventListener('mousemove', function(e) {
    var p = canvasCoords(e);
    if (document.pointerLockElement === canvas && (e.movementX !== undefined || e.movementY !== undefined)) {
      var r = canvas.getBoundingClientRect();
      var sxMul = W / (r.width || W);
      var syMul = H / (r.height || H);
      mouse.dx += (e.movementX || 0) * sxMul;
      mouse.dy += (e.movementY || 0) * syMul;
    } else {
      mouse.dx += (p.x - mouse.x);
      mouse.dy += (p.y - mouse.y);
    }
    mouse.x = p.x; mouse.y = p.y; mouse.rx = p.rx; mouse.ry = p.ry; mouse.wx = p.wx; mouse.wy = p.wy;
    hooks.pointermove.forEach(function(fn) { __rt._loopTicks = 0; Promise.resolve(fn(p.x, p.y)).catch(handleHookError); });
  });

  canvas.addEventListener('mousedown', function(e) {
    var p = canvasCoords(e);
    mouse.x = p.x; mouse.y = p.y; mouse.rx = p.rx; mouse.ry = p.ry; mouse.wx = p.wx; mouse.wy = p.wy;
    if (debugOverlay && e.button === 0) {
      for (var dsi = 0; dsi < debugSceneRects.length; dsi++) {
        var sr = debugSceneRects[dsi];
        if (p.x >= sr.x && p.x <= sr.x + sr.w && p.y >= sr.y && p.y <= sr.y + sr.h) {
          gotoScene(sr.name);
          return;
        }
      }
      for (var dgi = 0; dgi < debugGhostRects.length; dgi++) {
        var gr = debugGhostRects[dgi];
        if (p.x >= gr.x && p.x <= gr.x + gr.w && p.y >= gr.y && p.y <= gr.y + gr.h) {
          if (gr.act === 'rec') {
            if (ghostRec.active) { ghostStop(); showToast('Призрак записан (' + (f3GhostClip ? f3GhostClip.frames.length : 0) + ' кадр.)', '#34d399', 1600); }
            else { ghostRecord(cam.followTarget || worldEntities[0]); showToast('Запись призрака...', '#f87171', 1200); }
          } else if (gr.act === 'play' && f3GhostClip) {
            ghostPlay(f3GhostClip, { color: '#38bdf8', alpha: 0.45 });
          }
          return;
        }
      }
    }
    if (e.button === 0 && dialogueHandleClick(p.x, p.y)) return;
    if (e.button === 2) { mouse.rightDown = true; mouse.rightClicked = true; }
    else if (e.button === 1) { mouse.middleDown = true; }
    else { mouse.down = true; mouse.clicked = true; }
    hooks.click.forEach(function(fn) { __rt._loopTicks = 0; Promise.resolve(fn(p.x, p.y, e.button)).catch(handleHookError); });
  });

  window.addEventListener('mouseup', function(e) {
    if (e.button === 2) mouse.rightDown = false;
    else if (e.button === 1) mouse.middleDown = false;
    else { if (mouse.down) mouse.justReleased = true; mouse.down = false; }
  });

  canvas.addEventListener('touchstart', function(e) {
    e.preventDefault();
    updateTouchesList(e.touches);
    if (touches.length === 1) {
      var t0 = touches[0];
      mouse.x = t0.x; mouse.y = t0.y; mouse.rx = t0.wx; mouse.ry = t0.wy; mouse.wx = t0.wx; mouse.wy = t0.wy;
      gestureState.touchStartX = t0.x; gestureState.touchStartY = t0.y;
      gestureState.touchStartTime = performance.now();
      gestureState.touchMoved = false;
      var nowTap = gestureState.touchStartTime;
      if (nowTap - gestureState.lastTapTime < 320 && Math.hypot(t0.x - gestureState.lastTapX, t0.y - gestureState.lastTapY) < 42) {
        gestureState.doubleTap = { x: t0.x, y: t0.y, wx: t0.wx, wy: t0.wy };
        gestureState.lastTapTime = 0;
      } else {
        gestureState.lastTapTime = nowTap; gestureState.lastTapX = t0.x; gestureState.lastTapY = t0.y;
      }
      mouse.down = true; mouse.clicked = true;
      hooks.click.forEach(function(fn) { __rt._loopTicks = 0; Promise.resolve(fn(t0.x, t0.y, 0)).catch(handleHookError); });
    } else if (touches.length >= 2) {
      gestureState.prevPinchDist = Math.hypot(touches[1].x - touches[0].x, touches[1].y - touches[0].y);
      gestureState.pinchCx = (touches[0].x + touches[1].x) * 0.5;
      gestureState.pinchCy = (touches[0].y + touches[1].y) * 0.5;
    }
  }, { passive: false });

  canvas.addEventListener('touchmove', function(e) {
    e.preventDefault();
    updateTouchesList(e.touches);
    if (touches.length >= 2) {
      var nd = Math.hypot(touches[1].x - touches[0].x, touches[1].y - touches[0].y);
      if (gestureState.prevPinchDist > 4 && nd > 4) {
        var deltaP = (nd - gestureState.prevPinchDist) / Math.max(40, gestureState.prevPinchDist);
        gestureState.pinch += deltaP;
        gestureState.pinchScale = Math.max(0.2, Math.min(5, gestureState.pinchScale * (nd / gestureState.prevPinchDist)));
      }
      gestureState.prevPinchDist = nd;
      gestureState.pinchCx = (touches[0].x + touches[1].x) * 0.5;
      gestureState.pinchCy = (touches[0].y + touches[1].y) * 0.5;
      gestureState.touchMoved = true;
    } else if (touches.length === 1) {
      var t0 = touches[0];
      mouse.dx += (t0.x - mouse.x); mouse.dy += (t0.y - mouse.y);
      mouse.x = t0.x; mouse.y = t0.y; mouse.rx = t0.wx; mouse.ry = t0.wy; mouse.wx = t0.wx; mouse.wy = t0.wy;
      if (Math.hypot(t0.x - gestureState.touchStartX, t0.y - gestureState.touchStartY) > 22) gestureState.touchMoved = true;
      hooks.pointermove.forEach(function(fn) { __rt._loopTicks = 0; Promise.resolve(fn(t0.x, t0.y)).catch(handleHookError); });
    }
  }, { passive: false });

  canvas.addEventListener('touchend', function(e) {
    if (touches.length === 1 && e.touches.length === 0) {
      var sdx = mouse.x - gestureState.touchStartX;
      var sdy = mouse.y - gestureState.touchStartY;
      var dtSw = performance.now() - gestureState.touchStartTime;
      if (dtSw < 450 && Math.hypot(sdx, sdy) > 38) {
        gestureState.swipe = Math.abs(sdx) >= Math.abs(sdy) ? (sdx > 0 ? 'right' : 'left') : (sdy > 0 ? 'down' : 'up');
      }
    }
    if (e.touches.length < 2) gestureState.prevPinchDist = 0;
    updateTouchesList(e.touches);
    if (touches.length === 0) {
      if (mouse.down) mouse.justReleased = true;
      mouse.down = false;
    }
  });
  canvas.addEventListener('touchcancel', function(e) {
    updateTouchesList(e.touches);
    if (touches.length === 0) mouse.down = false;
  });

  canvas.addEventListener('wheel', function(e) {
    e.preventDefault();
    mouse.wheel = e.deltaY;
    hooks.wheel.forEach(function(fn) { __rt._loopTicks = 0; Promise.resolve(fn(e.deltaY)).catch(handleHookError); });
  }, { passive: false });

  function renderDebugOverlay() {
    debugSceneRects.length = 0;
    debugGhostRects.length = 0;
    if (!debugOverlay) return;
    // Hitboxes in world space
    rootCtx.save();
    rootCtx.setTransform(DPR, 0, 0, DPR, 0, 0);
    if (frameCamTransform.active) {
      rootCtx.translate(W / 2 + frameCamTransform.ox, H / 2 + frameCamTransform.oy);
      rootCtx.scale(cam.zoom, cam.zoom);
      rootCtx.translate(-W / 2 - cam.x, -H / 2 - cam.y);
    }
    rootCtx.lineWidth = 1.25 / (cam.zoom || 1);
    for (var ei = 0; ei < worldEntities.length; ei++) {
      var ent = worldEntities[ei];
      if (!ent || ent.alive === false) continue;
      rootCtx.strokeStyle = 'rgba(56,189,248,0.85)';
      if (ent._shape === 'circle' || (ent.r !== undefined && !ent.w)) {
        var cr = Number(ent.r) || 12;
        rootCtx.beginPath();
        rootCtx.arc(Number(ent.x) || 0, Number(ent.y) || 0, cr, 0, Math.PI * 2);
        rootCtx.stroke();
      } else {
        rootCtx.strokeRect(Number(ent.x) || 0, Number(ent.y) || 0, Number(ent.w) || 16, Number(ent.h) || 16);
      }
      if (ent.tag) {
        rootCtx.fillStyle = 'rgba(186,230,253,0.9)';
        rootCtx.font = '600 ' + Math.round(10 / (cam.zoom || 1)) + 'px monospace';
        rootCtx.fillText(String(ent.tag), Number(ent.x) || 0, (Number(ent.y) || 0) - 3);
      }
    }
    rootCtx.restore();

    // Screen-space telemetry + phase profiler + ghost controls + scene switcher HUD (top-right)
    rootCtx.save();
    rootCtx.setTransform(DPR, 0, 0, DPR, 0, 0);
    var pw = 256;
    var scenesList = registeredScenes.length ? registeredScenes : [currentScene];
    var ph = 186 + scenesList.length * 22;
    var px = W - pw - 10, py = 10;
    rootCtx.fillStyle = 'rgba(2, 6, 23, 0.88)';
    rootCtx.strokeStyle = 'rgba(56, 189, 248, 0.55)';
    rootCtx.lineWidth = 1;
    if (rootCtx.roundRect) { rootCtx.beginPath(); rootCtx.roundRect(px, py, pw, ph, 8); rootCtx.fill(); rootCtx.stroke(); }
    else { rootCtx.fillRect(px, py, pw, ph); rootCtx.strokeRect(px, py, pw, ph); }

    rootCtx.font = '700 11px monospace';
    rootCtx.textBaseline = 'top';
    rootCtx.textAlign = 'left';
    rootCtx.fillStyle = '#38bdf8';
    rootCtx.fillText('ROY DEBUG [F3] · v6.2', px + 10, py + 8);
    rootCtx.font = '500 11px monospace';
    rootCtx.fillStyle = '#e2e8f0';
    var loopPct = Math.min(100, Math.round((lastLoopTicks / 1000000) * 100));
    rootCtx.fillText('FPS: ' + currentFps + '   Scale: ' + gameplayTimeScale.toFixed(2) + 'x', px + 10, py + 25);
    rootCtx.fillText('Entities: ' + worldEntities.length + '   Particles: ' + pCount, px + 10, py + 41);
    rootCtx.fillStyle = loopPct > 70 ? '#f87171' : '#94a3b8';
    rootCtx.fillText('LoopTicks: ' + loopPct + '%   PostFX: ' + (fxState.enabled ? (glLost ? '2D' : 'WebGL2') : 'OFF'), px + 10, py + 57);

    // Phase Profiler Breakdown
    var pTot = Math.max(0.1, profStats.update + profStats.draw + profStats.light + profStats.postfx + profStats.ui);
    rootCtx.fillStyle = '#cbd5e1';
    rootCtx.fillText('Frame: ' + profStats.total.toFixed(1) + 'ms (CPU ' + pTot.toFixed(1) + 'ms)', px + 10, py + 75);
    var barW = pw - 20, bxBar = px + 10, byBar = py + 91;
    var phases = [
      { v: profStats.update, c: '#38bdf8', lbl: 'U' },
      { v: profStats.draw, c: '#34d399', lbl: 'D' },
      { v: profStats.light, c: '#fbbf24', lbl: 'L' },
      { v: profStats.postfx, c: '#c084fc', lbl: 'FX' },
      { v: profStats.ui, c: '#f472b6', lbl: 'UI' }
    ];
    rootCtx.fillStyle = '#0f172a';
    rootCtx.fillRect(bxBar, byBar, barW, 8);
    var curX = bxBar;
    for (var pi = 0; pi < phases.length; pi++) {
      var segW = Math.max(0, (phases[pi].v / pTot) * barW);
      if (segW > 0.4) {
        rootCtx.fillStyle = phases[pi].c;
        rootCtx.fillRect(curX, byBar, segW, 8);
        curX += segW;
      }
    }
    rootCtx.font = '500 9.5px monospace';
    rootCtx.fillStyle = '#94a3b8';
    rootCtx.fillText('U:' + profStats.update.toFixed(1) + ' D:' + profStats.draw.toFixed(1) + ' L:' + profStats.light.toFixed(1) + ' FX:' + profStats.postfx.toFixed(1) + ' UI:' + profStats.ui.toFixed(1), px + 10, py + 103);

    // Ghost quick buttons
    var gBtnY = py + 121, gBtnW = (pw - 26) / 2;
    rootCtx.font = '700 10px monospace';
    rootCtx.fillStyle = ghostRec.active ? 'rgba(239,68,68,0.35)' : 'rgba(30,41,59,0.85)';
    rootCtx.strokeStyle = ghostRec.active ? '#f87171' : 'rgba(148,163,184,0.4)';
    rootCtx.fillRect(px + 10, gBtnY, gBtnW, 20);
    rootCtx.strokeRect(px + 10, gBtnY, gBtnW, 20);
    rootCtx.fillStyle = ghostRec.active ? '#fecaca' : '#e2e8f0';
    rootCtx.fillText(ghostRec.active ? '⏹ STOP REC' : '● REC GHOST', px + 16, gBtnY + 5);
    debugGhostRects.push({ act: 'rec', x: px + 10, y: gBtnY, w: gBtnW, h: 20 });

    var gPlayX = px + 16 + gBtnW;
    rootCtx.fillStyle = f3GhostClip ? 'rgba(56,189,248,0.22)' : 'rgba(15,23,42,0.6)';
    rootCtx.strokeStyle = f3GhostClip ? '#38bdf8' : 'rgba(148,163,184,0.25)';
    rootCtx.fillRect(gPlayX, gBtnY, gBtnW, 20);
    rootCtx.strokeRect(gPlayX, gBtnY, gBtnW, 20);
    rootCtx.fillStyle = f3GhostClip ? '#7dd3fc' : '#64748b';
    rootCtx.fillText('▶ PLAY (' + (f3GhostClip ? f3GhostClip.frames.length : 0) + ')', gPlayX + 6, gBtnY + 5);
    debugGhostRects.push({ act: 'play', x: gPlayX, y: gBtnY, w: gBtnW, h: 20 });

    rootCtx.font = '500 11px monospace';
    rootCtx.fillStyle = '#94a3b8';
    rootCtx.fillText('Scenes (' + currentScene + ', depth ' + sceneStack.length + '):', px + 10, py + 150);

    for (var si = 0; si < scenesList.length; si++) {
      var scName = scenesList[si];
      var by = py + 168 + si * 22;
      var bx = px + 10, bw = pw - 20, bh = 18;
      var isAct = scName === currentScene;
      rootCtx.fillStyle = isAct ? 'rgba(56,189,248,0.28)' : 'rgba(30,41,59,0.75)';
      rootCtx.strokeStyle = isAct ? '#38bdf8' : 'rgba(148,163,184,0.35)';
      if (rootCtx.roundRect) { rootCtx.beginPath(); rootCtx.roundRect(bx, by, bw, bh, 4); rootCtx.fill(); rootCtx.stroke(); }
      else { rootCtx.fillRect(bx, by, bw, bh); rootCtx.strokeRect(bx, by, bw, bh); }
      rootCtx.fillStyle = isAct ? '#f8fafc' : '#cbd5e1';
      rootCtx.fillText((isAct ? '▶ ' : '  ') + scName, bx + 6, by + 3);
      debugSceneRects.push({ name: scName, x: bx, y: by, w: bw, h: bh });
    }
    rootCtx.restore();
  }

  var userProgramFn = new Function('__rt', 'RoySDK', '__royLoopTick',
    'with (__rt) {\\n' +
    'return (async function(){\\n' +
    ${JSON.stringify(safeCode)} +
    '\\n})();\\n' +
    '}'
  );

  var lastTs = performance.now();
  var fpsFrames = 0, fpsAcc = 0;

  var PAD_BTN_NAMES = ['PadA','PadB','PadX','PadY','PadLB','PadRB','PadLT','PadRT','PadBack','PadStart','PadLStick','PadRStick','PadUp','PadDown','PadLeft','PadRight'];
  function pollHardwareGamepad() {
    hwPadState.justPressed = {};
    hwPadState.justReleased = {};
    var list = null;
    try { list = (navigator && navigator.getGamepads) ? navigator.getGamepads() : null; } catch(e) {}
    var gp = null;
    if (list) {
      for (var gi = 0; gi < list.length; gi++) { if (list[gi] && list[gi].connected) { gp = list[gi]; break; } }
    }
    if (!gp) {
      if (hwPadState.connected) {
        hwPadState.connected = false; hwPadState.id = '';
        hwPadState.lx = 0; hwPadState.ly = 0; hwPadState.rx = 0; hwPadState.ry = 0; hwPadState.lt = 0; hwPadState.rt = 0;
        PAD_BTN_NAMES.forEach(function(nm) {
          if (hwPadState.btns[nm]) { hwPadState.justReleased[nm] = true; keysJustReleased[nm] = true; delete keysDown[nm]; }
        });
        hwPadState.btns = {}; hwPadState.prevBtns = {};
      }
      return;
    }
    hwPadState.connected = true;
    hwPadState.id = gp.id || 'Gamepad';
    function dz(v) { var n = Number(v) || 0; return Math.abs(n) < 0.2 ? 0 : (n > 0 ? (n - 0.2) / 0.8 : (n + 0.2) / 0.8); }
    hwPadState.lx = dz(gp.axes[0]); hwPadState.ly = dz(gp.axes[1]);
    hwPadState.rx = dz(gp.axes[2]); hwPadState.ry = dz(gp.axes[3]);
    hwPadState.lt = gp.buttons[6] ? (gp.buttons[6].value || 0) : 0;
    hwPadState.rt = gp.buttons[7] ? (gp.buttons[7].value || 0) : 0;
    for (var bi = 0; bi < PAD_BTN_NAMES.length; bi++) {
      var bn = PAD_BTN_NAMES[bi];
      var pressed = !!(gp.buttons[bi] && (gp.buttons[bi].pressed || gp.buttons[bi].value > 0.5));
      var was = !!hwPadState.btns[bn];
      hwPadState.btns[bn] = pressed;
      if (pressed && !was) { hwPadState.justPressed[bn] = true; keysJustPressed[bn] = true; keysDown[bn] = true; }
      else if (!pressed && was) { hwPadState.justReleased[bn] = true; keysJustReleased[bn] = true; delete keysDown[bn]; }
      else if (pressed) { keysDown[bn] = true; }
    }
  }

  function frameLoop(now) {
    totalFrames++;
    var tFrameStart = performance.now();
    pollHardwareGamepad();
    var rawDt = Math.min(0.05, Math.max(0.001, (now - lastTs) / 1000));
    lastTs = now;
    fpsFrames++; fpsAcc += rawDt;
    if (fpsAcc >= 0.5) { currentFps = Math.round(fpsFrames / fpsAcc); fpsFrames = 0; fpsAcc = 0; }
    telemetryTimer += rawDt;
    if (telemetryTimer >= 0.35) {
      telemetryTimer = 0;
      try {
        window.parent.postMessage({
          type: 'roystudio-telemetry',
          fps: currentFps,
          scene: currentScene,
          entities: worldEntities.length,
          particles: pCount,
          loopPct: Math.min(100, Math.round((lastLoopTicks / 1000000) * 100)),
          frameMs: Math.round(profStats.total * 10) / 10
        }, '*');
      } catch(e) {}
    }

    if (transitionState.active) {
      transitionState.elapsed += rawDt;
      if (!transitionState.switched && transitionState.elapsed >= transitionState.dur * 0.5) {
        transitionState.switched = true;
        applySceneSwitchNow(transitionState.target, transitionState.payload);
      }
      if (transitionState.elapsed >= transitionState.dur) {
        transitionState.active = false;
      }
    }

    var frozen = false;
    if (freezeRem > 0) {
      freezeRem = Math.max(0, freezeRem - rawDt);
      frozen = true;
    }

    var dt = rawDt * gameplayTimeScale;
    lastLoopTicks = __rt._loopTicks;
    __rt._loopTicks = 0;

    if (dialogueState.active) {
      dialogueState.drawnThisFrame = false;
      dialogueState.cooldown = Math.max(0, dialogueState.cooldown - rawDt);
      if (dialogueState.shownChars < dialogueState.fullText.length) {
        var prevWhole = Math.floor(dialogueState.shownChars);
        dialogueState.shownChars = Math.min(dialogueState.fullText.length, dialogueState.shownChars + dialogueState.speed * rawDt);
        var nextWhole = Math.floor(dialogueState.shownChars);
        dialogueState.audioAcc += rawDt;
        if (nextWhole > prevWhole && dialogueState.audioAcc >= 0.055 && !audioMuted && !tabMuted && audioCtx && audioCtx.state === 'running') {
          dialogueState.audioAcc = 0;
          tone(520 + (nextWhole % 3) * 45, 22, 'triangle', 0.025);
        }
      }
    }

    var tUpd0 = performance.now();
    if (!frozen && dt > 0) {
      gameTime += dt;
      sceneTime += dt;
      sceneFrame++;
      for (var swi = shockwaves.length - 1; swi >= 0; swi--) {
        shockwaves[swi].t += dt;
        if (shockwaves[swi].t >= shockwaves[swi].dur) shockwaves.splice(swi, 1);
      }
      for (var ai = afterTimers.length - 1; ai >= 0; ai--) {
        var aftItem = afterTimers[ai];
        if (aftItem.owner && aftItem.owner.alive === false) { afterTimers.splice(ai, 1); continue; }
        if (aftItem.scene !== null && aftItem.scene !== currentScene) continue;
        aftItem.rem -= dt;
        if (aftItem.rem <= 0) {
          afterTimers.splice(ai, 1);
          Promise.resolve(aftItem.fn()).catch(handleHookError);
        }
      }
      for (var ti = timers.length - 1; ti >= 0; ti--) {
        var tItem = timers[ti];
        if (tItem.owner && tItem.owner.alive === false) { timers.splice(ti, 1); continue; }
        if (tItem.scene !== null && tItem.scene !== currentScene) continue;
        tItem.acc += dt;
        while (tItem.acc >= tItem.interval) {
          tItem.acc -= tItem.interval;
          if (tItem.owner && tItem.owner.alive === false) break;
          Promise.resolve(tItem.fn()).catch(handleHookError);
        }
      }
      for (var twi = tweens.length - 1; twi >= 0; twi--) {
        var tw = tweens[twi];
        if (tw.scene !== null && tw.scene !== currentScene) continue;
        tw.t += dt / tw.dur;
        var k = Math.min(1, tw.t);
        tw.obj[tw.prop] = tw.from + (tw.to - tw.from) * tw.ease(k);
        if (k >= 1) { tweens.splice(twi, 1); tw.resolve(tw.obj); }
      }
      for (var wi = taskWaiters.length - 1; wi >= 0; wi--) {
        var w = taskWaiters[wi];
        if (w.task && _isTaskDead(w.task)) {
          taskWaiters.splice(wi, 1);
          try { w.resolve(); } catch(e) {}
          continue;
        }
        if (w.scene !== null && w.scene !== currentScene) continue;
        if (w.kind === 'frames') {
          w.frames--;
          if (w.frames <= 0) { taskWaiters.splice(wi, 1); try { w.resolve(); } catch(e) {} }
        } else if (w.kind === 'time') {
          w.rem -= dt;
          if (w.rem <= 0) { taskWaiters.splice(wi, 1); try { w.resolve(); } catch(e) {} }
        } else if (w.kind === 'cond') {
          var condOk = false;
          try { condOk = !!w.fn(); } catch(err) { handleHookError(err); condOk = true; }
          if (condOk) { taskWaiters.splice(wi, 1); try { w.resolve(); } catch(e) {} }
        }
      }
      for (var ei = 0; ei < worldEntities.length; ei++) {
        var ent = worldEntities[ei];
        if (!ent || ent.alive === false) continue;
        if (ent._scene && ent._scene !== currentScene) continue;
        ent.stateTime = (ent.stateTime || 0) + dt;
        if (typeof ent.update === 'function') {
          Promise.resolve(ent.update(dt)).catch(handleHookError);
        }
        if (ent._states && ent.state && ent._states[ent.state] && typeof ent._states[ent.state].update === 'function') {
          Promise.resolve(ent._states[ent.state].update(dt)).catch(handleHookError);
        }
      }
      for (var ani = 0; ani < activeAnims.length; ani++) {
        var an = activeAnims[ani];
        if (an && an.lastTickFrame !== totalFrames) {
          an.update(dt);
        }
      }
      for (var ui = 0; ui < hooks.update.length; ui++) {
        Promise.resolve(hooks.update[ui](dt)).catch(handleHookError);
      }
      updateNetSyncs(dt);
      updateAndDrawGhosts(dt, false);
      for (var er = worldEntities.length - 1; er >= 0; er--) {
        if (!worldEntities[er] || worldEntities[er].alive === false) worldEntities.splice(er, 1);
      }
      var pi = 0;
      while (pi < pCount) {
        pLife[pi] -= dt;
        if (pLife[pi] <= 0) {
          var lastIdx = --pCount;
          if (pi !== lastIdx) {
            pX[pi] = pX[lastIdx]; pY[pi] = pY[lastIdx];
            pVx[pi] = pVx[lastIdx]; pVy[pi] = pVy[lastIdx];
            pLife[pi] = pLife[lastIdx]; pMaxLife[pi] = pMaxLife[lastIdx];
            pSz0[pi] = pSz0[lastIdx]; pSz1[pi] = pSz1[lastIdx];
            pGrav[pi] = pGrav[lastIdx]; pDrag[pi] = pDrag[lastIdx];
            pR0[pi] = pR0[lastIdx]; pG0[pi] = pG0[lastIdx]; pB0[pi] = pB0[lastIdx];
            pR1[pi] = pR1[lastIdx]; pG1[pi] = pG1[lastIdx]; pB1[pi] = pB1[lastIdx];
            pBlend[pi] = pBlend[lastIdx];
          }
          continue;
        }
        if (pDrag[pi] > 0) {
          var damp = Math.max(0, 1 - pDrag[pi] * dt);
          pVx[pi] *= damp;
          pVy[pi] *= damp;
        }
        pVy[pi] += pGrav[pi] * dt;
        pX[pi] += pVx[pi] * dt;
        pY[pi] += pVy[pi] * dt;
        pi++;
      }
    }
    var msUpd = performance.now() - tUpd0;
    profStats.update = profStats.update * 0.85 + msUpd * 0.15;

    if (cam.followTarget) {
      var tx = (cam.followTarget.x || 0) - W / 2;
      var ty = (cam.followTarget.y || 0) - H / 2;
      var alphaCam = Math.min(1, rawDt * cam.followSmooth);
      cam.x += (tx - cam.x) * alphaCam;
      cam.y += (ty - cam.y) * alphaCam;
    }
    if (cam.bounds) {
      var halfViewW = (W / 2) / (cam.zoom || 1);
      var halfViewH = (H / 2) / (cam.zoom || 1);
      var bMinX = cam.bounds.minX + halfViewW - W / 2;
      var bMaxX = cam.bounds.maxX - halfViewW - W / 2;
      var bMinY = cam.bounds.minY + halfViewH - H / 2;
      var bMaxY = cam.bounds.maxY - halfViewH - H / 2;
      if (bMinX <= bMaxX) cam.x = Math.max(bMinX, Math.min(bMaxX, cam.x));
      if (bMinY <= bMaxY) cam.y = Math.max(bMinY, Math.min(bMaxY, cam.y));
    }
    var shakeOx = 0, shakeOy = 0;
    if (cam.shakeTime > 0) {
      cam.shakeTime = Math.max(0, cam.shakeTime - rawDt);
      var decay = cam.shakeDur > 0 ? cam.shakeTime / cam.shakeDur : 0;
      var mag = cam.shakePow * decay;
      shakeOx = (Math.random() * 2 - 1) * mag;
      shakeOy = (Math.random() * 2 - 1) * mag;
    } else { cam.shakePow = 0; }

    mouse.overUi = false;
    mouse.wx = (mouse.x - W / 2) / (cam.zoom || 1) + W / 2 + cam.x;
    mouse.wy = (mouse.y - H / 2) / (cam.zoom || 1) + H / 2 + cam.y;
    mouse.rx = mouse.wx; mouse.ry = mouse.wy;

    // 1. World Render Phase -> worldCanvas
    var tDraw0 = performance.now();
    frameBaseCtx = worldCtx;
    ctx = worldCtx;
    ctx.save();
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.shadowBlur = 0; ctx.shadowColor = 'transparent'; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    if (sceneStack.length > 0) {
      ctx.clearRect(0, 0, W, H);
    } else {
      gameObj.clear();
    }
    frameCamTransform.ox = shakeOx;
    frameCamTransform.oy = shakeOy;
    frameCamTransform.active = (cam.zoom !== 1 || cam.x !== 0 || cam.y !== 0 || shakeOx !== 0 || shakeOy !== 0);
    if (frameCamTransform.active) {
      ctx.translate(W / 2 + shakeOx, H / 2 + shakeOy);
      ctx.scale(cam.zoom, cam.zoom);
      ctx.translate(-W / 2 - cam.x, -H / 2 - cam.y);
    }
    entitiesDrawnThisFrame = false;
    inDraw = true;
    for (var di = 0; di < hooks.draw.length; di++) {
      Promise.resolve(hooks.draw[di]()).catch(handleHookError);
    }
    if (!entitiesDrawnThisFrame && worldEntities.length > 0) {
      drawEntitiesNow();
    }
    updateAndDrawGhosts(dt, true);
    inDraw = false;
    ctx = worldCtx;
    if (sceneStack.length === 0) updateAndDrawWeather((!frozen && dt > 0) ? dt : 0);
    ctx.shadowBlur = 0; ctx.shadowColor = 'transparent'; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
    var activePBlend = -1;
    for (var pj = 0; pj < pCount; pj++) {
      if (pBlend[pj] !== activePBlend) {
        activePBlend = pBlend[pj];
        ctx.globalCompositeOperation = activePBlend === 1 ? 'lighter' : 'source-over';
      }
      var prog = 1 - Math.max(0, Math.min(1, pLife[pj] / (pMaxLife[pj] || 1)));
      var sz = pSz0[pj] + (pSz1[pj] - pSz0[pj]) * prog;
      if (sz <= 0.1) continue;
      var cr = Math.round(pR0[pj] + (pR1[pj] - pR0[pj]) * prog);
      var cg = Math.round(pG0[pj] + (pG1[pj] - pG0[pj]) * prog);
      var cb = Math.round(pB0[pj] + (pB1[pj] - pB0[pj]) * prog);
      ctx.globalAlpha = Math.max(0, Math.min(1, 1 - prog));
      ctx.fillStyle = 'rgb(' + cr + ',' + cg + ',' + cb + ')';
      ctx.fillRect(pX[pj] - sz * 0.5, pY[pj] - sz * 0.5, sz, sz);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.restore();
    var msDraw = performance.now() - tDraw0;
    profStats.draw = profStats.draw * 0.85 + msDraw * 0.15;

    // 2. Half-Res 2D Lighting Multiply Pass on worldCanvas
    var tLight0 = performance.now();
    renderLightOverlayToWorld(shakeOx, shakeOy);
    var msLight = performance.now() - tLight0;
    profStats.light = profStats.light * 0.85 + msLight * 0.15;

    // 3. Composite World (and Frozen Scene Stack Underlays + WebGL2 Post-FX) to rootCtx
    var tFx0 = performance.now();
    frameBaseCtx = rootCtx;
    ctx = rootCtx;
    rootCtx.save();
    rootCtx.setTransform(1, 0, 0, 1, 0, 0);
    rootCtx.clearRect(0, 0, canvas.width, canvas.height);
    if (sceneStack.length > 0) {
      rootCtx.fillStyle = gameObj.bg || '#090d16';
      rootCtx.fillRect(0, 0, canvas.width, canvas.height);
      for (var sti = 0; sti < sceneStack.length; sti++) {
        var stLayer = sceneStack[sti];
        rootCtx.save();
        if (stLayer.blur > 0 && 'filter' in rootCtx) {
          rootCtx.filter = 'blur(' + stLayer.blur + 'px)';
        }
        rootCtx.drawImage(stLayer.snapCanvas, 0, 0, canvas.width, canvas.height);
        rootCtx.filter = 'none';
        if (stLayer.dim > 0) {
          rootCtx.fillStyle = 'rgba(0,0,0,' + stLayer.dim + ')';
          rootCtx.fillRect(0, 0, canvas.width, canvas.height);
        }
        rootCtx.restore();
      }
    }
    if (runWebGLPostFx()) {
      rootCtx.drawImage(glCanvas, 0, 0, canvas.width, canvas.height);
    } else {
      rootCtx.drawImage(worldCanvas, 0, 0, canvas.width, canvas.height);
    }
    rootCtx.restore();
    var msFx = performance.now() - tFx0;
    profStats.postfx = profStats.postfx * 0.85 + msFx * 0.15;

    // 4. Razor-sharp Screen UI & HUD Phase on rootCtx (bypasses Post-FX)
    var tUi0 = performance.now();
    if (hooks.drawUi.length > 0) {
      ctx = rootCtx;
      ctx.save();
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.shadowBlur = 0; ctx.shadowColor = 'transparent'; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      for (var uiIdx = 0; uiIdx < hooks.drawUi.length; uiIdx++) {
        Promise.resolve(hooks.drawUi[uiIdx]()).catch(handleHookError);
      }
      ctx = rootCtx;
      ctx.restore();
    }

    renderDialogueOverlay(false);
    renderQueuedTooltips();

    // Очередь встроенных тост-уведомлений
    if (toastQueue.length > 0) {
      ctx = rootCtx;
      ctx.save();
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      for (var ti2 = toastQueue.length - 1; ti2 >= 0; ti2--) {
        var tst = toastQueue[ti2];
        tst.rem -= rawDt;
        if (tst.rem <= 0) { toastQueue.splice(ti2, 1); continue; }
        var tAlpha = Math.min(1, tst.rem * 2.5, (tst.dur - tst.rem) * 6 + 0.2);
        var ty = 14 + ti2 * 38;
        ctx.globalAlpha = tAlpha;
        var twBox = Math.min(W - 40, Math.max(180, measureTextBox(tst.text, 13).width + 36));
        drawRect(W / 2 - twBox / 2, ty, twBox, 30, 'rgba(9,13,26,0.92)', 8);
        ctx.strokeStyle = tst.color || '#38bdf8';
        ctx.lineWidth = 1.5;
        if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(W / 2 - twBox / 2, ty, twBox, 30, 8); ctx.stroke(); }
        else ctx.strokeRect(W / 2 - twBox / 2, ty, twBox, 30);
        text(tst.text, W / 2, ty + 8, tst.color || '#f8fafc', 13, 'center');
      }
      ctx.restore();
    }

    if (runtimeErrorBanner) {
      ctx = rootCtx;
      ctx.save();
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      drawRect(12, H - 40, W - 24, 28, 'rgba(127,29,29,0.92)', 6);
      text('RoyLang: ' + runtimeErrorBanner, 22, H - 33, '#fecaca', 12, 'left');
      ctx.restore();
    }

    if (flashState.rem > 0) {
      flashState.rem = Math.max(0, flashState.rem - rawDt);
      rootCtx.save();
      rootCtx.setTransform(DPR, 0, 0, DPR, 0, 0);
      rootCtx.globalAlpha = flashState.dur > 0 ? Math.min(0.85, flashState.rem / flashState.dur) : 0;
      rootCtx.fillStyle = flashState.color || '#ffffff';
      rootCtx.fillRect(0, 0, W, H);
      rootCtx.restore();
    }

    if (transitionState.active) {
      var tp = Math.max(0, Math.min(1, transitionState.elapsed / (transitionState.dur || 0.4)));
      var tCov = tp < 0.5 ? (tp * 2) : ((1 - tp) * 2);
      rootCtx.save();
      rootCtx.setTransform(DPR, 0, 0, DPR, 0, 0);
      rootCtx.fillStyle = transitionState.color || '#000000';
      if (transitionState.kind === 'iris') {
        var maxR = Math.hypot(W * 0.5, H * 0.5) + 4;
        var holeR = Math.max(0, maxR * (1 - tCov));
        rootCtx.beginPath();
        rootCtx.rect(0, 0, W, H);
        rootCtx.arc(W * 0.5, H * 0.5, holeR, 0, Math.PI * 2, true);
        rootCtx.fill('evenodd');
      } else {
        rootCtx.globalAlpha = tCov;
        rootCtx.fillRect(0, 0, W, H);
      }
      rootCtx.restore();
    }
    var msUi = performance.now() - tUi0;
    profStats.ui = profStats.ui * 0.85 + msUi * 0.15;

    renderDebugOverlay();
    var msTot = performance.now() - tFrameStart;
    profStats.total = profStats.total * 0.85 + msTot * 0.15;

    keysJustPressed = {};
    keysJustReleased = {};
    mouse.clicked = false;
    mouse.rightClicked = false;
    mouse.justReleased = false;
    mouse.wheel = 0;
    mouse.dx = 0;
    mouse.dy = 0;
    gestureState.swipe = null;
    gestureState.pinch = 0;
    gestureState.doubleTap = null;
    uiLayoutStack.length = 0;
    requestAnimationFrame(frameLoop);
  }

  preloadManifestAssets(ASSET_MANIFEST).then(function(assetObj) {
    __rt._assets = assetObj || {};
    return Promise.resolve(userProgramFn(__rt, sdk, __royLoopTick));
  }).then(function() {
    var sList = hooks.start.slice();
    var chain = Promise.resolve();
    sList.forEach(function(fn) {
      chain = chain.then(function(){ __rt._loopTicks = 0; return fn(); });
    });
    return chain;
  }).then(function() {
    if (INITIAL_START_SCENE && INITIAL_START_SCENE !== 'main') {
      regSceneName(INITIAL_START_SCENE);
      applySceneSwitchNow(INITIAL_START_SCENE, null);
    }
    lastTs = performance.now();
    requestAnimationFrame(frameLoop);
  }).catch(function(err) {
    var pretty = formatRoyError(err);
    emitConsole('error', pretty);
    rootCtx.setTransform(DPR, 0, 0, DPR, 0, 0);
    rootCtx.fillStyle = '#090d16';
    rootCtx.fillRect(0, 0, W, H);
    rootCtx.fillStyle = '#f87171';
    rootCtx.font = '700 17px system-ui, sans-serif';
    rootCtx.fillText('Ошибка RoyLang: ' + pretty, 20, 32);
  });
})();
  <\/script>
</body>
</html>`;
  }

  async function buildBundleZipPayload(source, fallbackTitle, rawFileName, projectFiles = null, entryPath = 'main.roy') {
    const compiled = compile(source, projectFiles, entryPath);
    const html = compileToHtml(source, { title: fallbackTitle }, projectFiles, entryPath);
    const JSZipLib = await _royEnsureJSZip();
    const zip = new JSZipLib();
    zip.file('index.html', html);
    const entryNorm = normalizeRelPath(entryPath || 'main.roy') || 'main.roy';
    zip.file(entryNorm, String(source || ''));
    let totalCount = 2;
    if (projectFiles && typeof projectFiles === 'object') {
      Object.keys(projectFiles).forEach(relKey => {
        const norm = normalizeRelPath(relKey);
        if (!norm || norm === 'index.html' || norm === entryNorm) return;
        const rawEntry = projectFiles[relKey];
        if (!rawEntry) return;
        const entry = typeof rawEntry === 'string' ? { type: 'text', content: rawEntry } : rawEntry;
        if (entry.type === 'base64') {
          zip.file(norm, entry.content || '', { base64: true });
        } else {
          zip.file(norm, String(entry.content || ''));
        }
        totalCount++;
      });
    }
    const ab = await zip.generateAsync({ type: 'arraybuffer' });
    const b64 = _royArrayBufferToBase64(ab);
    return {
      fileName: rawFileName || entryNorm,
      zipSizeBytes: ab.byteLength,
      fileCount: totalCount,
      entryFile: 'index.html',
      engine: 'roylang',
      royLangMeta: compiled.meta,
      base64: b64
    };
  }

  return { tokenize, parse, compile, compileToHtml, buildBundleZipPayload, guessMime };
})();
if (typeof window !== "undefined") {
  window.RoyLang = RoyLang;
}
export default RoyLang;
