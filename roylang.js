// RoyLang v3 Compiler, AST Codegen & 2D Engine Runtime (lazy-loaded module)
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
    'game', 'entity', 'class', 'enum', 'spawn', 'new', 'this', 'self',
    'var', 'let', 'const', 'fn', 'return', 'if', 'elif', 'else', 'match',
    'while', 'for', 'in', 'repeat', 'break', 'continue',
    'on', 'after', 'every', 'import', 'export',
    'true', 'false', 'null', 'and', 'or', 'not', 'await'
  ]);

  const ASYNC_ROOTS = new Set(['save', 'load', 'submitScore', 'topScores', 'wait', 'loadJson']);
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
        let inner = null;
        if (nt.type === 'KW' && nt.value === 'fn') inner = parseFnDecl();
        else if (nt.type === 'KW' && (nt.value === 'entity' || nt.value === 'class')) inner = parseEntityDecl();
        else if (nt.type === 'KW' && nt.value === 'enum') inner = parseEnumDecl();
        else if (nt.type === 'KW' && (nt.value === 'var' || nt.value === 'let' || nt.value === 'const')) inner = parseVarDecl();
        else throw compileError('После export поддерживаются fn, entity, class, enum, let/var/const', nt.line, nt.col, fileName);
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
            const pTok = expect('IDENT', undefined, 'Ожидалось имя параметра');
            let defVal = null;
            if (!isRest && match('OP', '=')) {
              defVal = parseExpression();
            }
            params.push({ name: pTok.value, defVal, rest: isRest });
            if (isRest) break;
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
          if (t.value === 'break') { pos++; match('PUNC', ';'); return { type: 'Break', line: t.line, col: t.col }; }
          if (t.value === 'continue') { pos++; match('PUNC', ';'); return { type: 'Continue', line: t.line, col: t.col }; }
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
        const kw = expect('KW', 'fn');
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
        return { type: 'FnDecl', name: nameTok.value, params, body, line: kw.line, col: kw.col };
      }

      function parseEntityDecl() {
        const kw = expect('KW');
        const nameTok = expect('IDENT', undefined, 'Ожидалось имя сущности (entity)');
        const ctorParams = isVal('PUNC', '(') ? parseParamDefs(true) : [];
        expect('PUNC', '{', 'Ожидалась "{" после объявления entity');
        const fields = [];
        const methods = [];
        let initMethod = null;
        while (!isVal('PUNC', '}') && !atEnd()) {
          while (match('PUNC', ';') || match('PUNC', ',')) {}
          if (isVal('PUNC', '}')) break;
          const nt = peek();
          if (isVal('KW', 'fn')) {
            const m = parseFnDecl();
            if (m.name === 'init') initMethod = m;
            else methods.push(m);
          } else if (isVal('KW', 'let') || isVal('KW', 'var') || isVal('KW', 'const')) {
            const vd = parseVarDecl();
            if (!vd.name) throw compileError('Внутри entity поля должны иметь простые имена', vd.line, vd.col, fileName);
            fields.push({ name: vd.name, init: vd.init, line: vd.line, col: vd.col });
          } else if (nt.type === 'IDENT' && (peek(1).value === '=' || peek(1).value === ':')) {
            const fTok = nt; pos++;
            pos++;
            const fVal = parseExpression();
            match('PUNC', ';'); match('PUNC', ',');
            fields.push({ name: fTok.value, init: fVal, line: fTok.line, col: fTok.col });
          } else {
            throw compileError(`Внутри entity ожидались поля или методы fn (...), встречено "${nt.value || nt.type}"`, nt.line, nt.col, fileName);
          }
        }
        expect('PUNC', '}', 'Ожидалась "}" в конце entity');
        return { type: 'EntityDecl', name: nameTok.value, ctorParams, fields, methods, initMethod, line: kw.line, col: kw.col };
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
        while (true) {
          const tk = peek(off);
          if (tk.type === 'EOF') return false;
          if (tk.type === 'PUNC' && tk.value === ')') {
            return peek(off + 1).type === 'OP' && peek(off + 1).value === '=>';
          }
          if (tk.type === 'IDENT' || (tk.type === 'PUNC' && tk.value === ',')) {
            off++;
            continue;
          }
          return false;
        }
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
      pixelated: false
    };

    if (ast.gameHeader) {
      if (ast.gameHeader.title) meta.title = ast.gameHeader.title;
      const p = ast.gameHeader.props || {};
      if (p.title && p.title.type === 'Literal') meta.title = String(p.title.value);
      if (p.width && p.width.type === 'Literal' && Number(p.width.value) >= 120) meta.width = Math.min(2048, Number(p.width.value));
      if (p.height && p.height.type === 'Literal' && Number(p.height.value) >= 120) meta.height = Math.min(2048, Number(p.height.value));
      if (p.size && p.size.type === 'SizeLiteral') {
        meta.width = Math.max(120, Math.min(2048, p.size.width));
        meta.height = Math.max(120, Math.min(2048, p.size.height));
      }
      if (p.bg && p.bg.type === 'Literal') meta.bg = String(p.bg.value);
      if (p.fps && p.fps.type === 'Literal' && Number(p.fps.value) > 0) meta.fps = Math.max(10, Math.min(120, Number(p.fps.value)));
      if (p.pixelated && p.pixelated.type === 'Literal') meta.pixelated = !!p.pixelated.value;
    }

    const asyncFnNames = new Set();
    function astHasAwait(node) {
      if (!node || typeof node !== 'object') return false;
      if (node.type === 'Await') return true;
      if (node.type === 'Call') {
        const name = calleeChainName(node.callee);
        if (ASYNC_ROOTS.has(name) || ASYNC_MEMBERS.has(name) || asyncFnNames.has(name)) return true;
      }
      if (node.type === 'FnExpr' || node.type === 'FnDecl') return false;
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

    let seq = 0;
    const nextTmp = (p) => `__roy_${p}_${++seq}`;

    function emitParams(params) {
      return (params || []).map(p => {
        if (typeof p === 'string') return p;
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
          return `({ ${node.entries.map(e => e.spread ? `...(${emitExpr(e.val)})` : `${JSON.stringify(e.key)}: ${emitExpr(e.val)}`).join(', ')} })`;
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
          const fnAsync = astHasAwait(node.body);
          return `(${fnAsync ? 'async ' : ''}function(${emitParams(node.params)}) ${emitBlock(node.body)})`;
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

    function emitBlock(blockNode) {
      return `{\n${blockNode.stmts.map(s => emitStmt(s)).join('\n')}\n}`;
    }

    function emitStmt(node) {
      if (!node) return '';
      switch (node.type) {
        case 'Block': return emitBlock(node);
        case 'ModuleScope': {
          const innerCode = node.body.map(s => emitStmt(s)).join('\n');
          const expObj = `{ ${node.exportsList.map(n => `${JSON.stringify(n)}: ${n}`).join(', ')} }`;
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
          const isAsync = asyncFnNames.has(node.name) || astHasAwait(node.body);
          return `${isAsync ? 'async ' : ''}function ${node.name}(${emitParams(node.params)}) ${emitBlock(node.body)}`;
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
        case 'EntityDecl': {
          const ctorParamList = emitParams(node.ctorParams);
          const assignParams = node.ctorParams.map(p => `this[${JSON.stringify(p.name)}] = ${p.name};`).join(' ');
          const fieldInits = node.fields.map(f => `this[${JSON.stringify(f.name)}] = ${f.init ? emitExpr(f.init) : 'null'};`).join(' ');
          const initCall = node.initMethod ? `this.init(${node.ctorParams.map(p => p.name).join(', ')});` : '';
          const methodsOut = [];
          if (node.initMethod) {
            methodsOut.push(`init(${emitParams(node.initMethod.params)}) ${emitBlock(node.initMethod.body)}`);
          }
          node.methods.forEach(m => {
            const mAsync = astHasAwait(m.body);
            methodsOut.push(`${mAsync ? 'async ' : ''}${m.name}(${emitParams(m.params)}) ${emitBlock(m.body)}`);
          });
          return `class ${node.name} extends __rt.BaseEntity {\nconstructor(${ctorParamList}) {\nsuper(${JSON.stringify(node.name)});\n${assignParams}\n${fieldInits}\n${initCall}\n}\n${methodsOut.join('\n')}\n}`;
        }
        case 'OnHook': {
          const isAsync = astHasAwait(node.body);
          const evKey = (node.event === 'enter' || node.event === 'exit') && node.sceneFilter
            ? `${node.event}:${node.sceneFilter}`
            : node.event;
          const filterGuard = (node.sceneFilter && node.event !== 'enter' && node.event !== 'exit')
            ? `if (__rt.scene.name !== ${JSON.stringify(node.sceneFilter)}) return;\n`
            : '';
          const bodyJs = `{\n${filterGuard}${node.body.stmts.map(s => emitStmt(s)).join('\n')}\n}`;
          return `__rt.on(${JSON.stringify(evKey)}, ${isAsync ? 'async ' : ''}function(${emitParams(node.params)}) ${bodyJs});`;
        }
        case 'AfterHook': {
          const isAsync = astHasAwait(node.body);
          return `__rt.after(${emitExpr(node.msExpr)}, ${isAsync ? 'async ' : ''}function() ${emitBlock(node.body)});`;
        }
        case 'EveryHook': {
          const isAsync = astHasAwait(node.body);
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
          return `while (${emitExpr(node.cond)}) { __royLoopTick(); ${node.body.stmts.map(s => emitStmt(s)).join('\n')} }`;
        case 'ForRange': {
          const eVar = nextTmp('end');
          const cmp = node.inclusive ? '<=' : '<';
          return `{ const ${eVar} = ${emitExpr(node.end)}; for (let ${node.varName} = ${emitExpr(node.start)}; ${node.varName} ${cmp} ${eVar}; ${node.varName}++) { __royLoopTick(); ${node.body.stmts.map(s => emitStmt(s)).join('\n')} } }`;
        }
        case 'ForEach': {
          const colVar = nextTmp('col');
          return `{ const ${colVar} = ${emitExpr(node.iterable)}; const __iterList = Array.isArray(${colVar}) ? ${colVar} : (${colVar} && typeof ${colVar} === 'object' ? Object.keys(${colVar}) : []); for (const ${node.varName} of __iterList) { __royLoopTick(); ${node.body.stmts.map(s => emitStmt(s)).join('\n')} } }`;
        }
        case 'ForEntries': {
          const colVar = nextTmp('col');
          return `{ const ${colVar} = ${emitExpr(node.iterable)}; const __iterEnt = Array.isArray(${colVar}) ? ${colVar}.map((__v, __i) => [__i, __v]) : (${colVar} && typeof ${colVar} === 'object' ? Object.entries(${colVar}) : []); for (const [${node.keyName}, ${node.valName}] of __iterEnt) { __royLoopTick(); ${node.body.stmts.map(s => emitStmt(s)).join('\n')} } }`;
        }
        case 'Repeat': {
          const cntVar = nextTmp('rep');
          const idxVar = nextTmp('i');
          return `{ const ${cntVar} = Math.max(0, Math.floor(${emitExpr(node.countExpr)})); for (let ${idxVar} = 0; ${idxVar} < ${cntVar}; ${idxVar}++) { __royLoopTick(); ${node.body.stmts.map(s => emitStmt(s)).join('\n')} } }`;
        }
        case 'Return':
          return node.value ? `return ${emitExpr(node.value)};` : 'return;';
        case 'Break': return 'break;';
        case 'Continue': return 'continue;';
        case 'ExprStmt': return `${emitExpr(node.expr)};`;
        default:
          throw compileError('Неподдерживаемая инструкция: ' + node.type, node.line || 1, node.col || 1);
      }
    }

    const assetDeclPrefix = (assetManifest || []).map(a => `const ${a.alias} = __rt._assets[${JSON.stringify(a.alias)}];`).join('\n');
    const jsBody = (assetDeclPrefix ? assetDeclPrefix + '\n' : '') + ast.body.map(s => emitStmt(s)).join('\n');
    return { jsCode: jsBody, meta };
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
      (body || []).forEach(st => {
        if (!st || !st.exported) return;
        if (st.type === 'FnDecl' || st.type === 'EntityDecl' || st.type === 'EnumDecl') {
          names.push(st.name);
        } else if (st.type === 'VarDecl') {
          if (st.name) names.push(st.name);
          else if (st.pattern && st.pattern.type === 'ArrayPat') st.pattern.elements.forEach(e => names.push(e.name));
          else if (st.pattern && st.pattern.type === 'ObjectPat') st.pattern.props.forEach(p => names.push(p.alias));
        }
      });
      return names;
    }

    function resolveAstImports(astNode, currentFile, isTopEntry) {
      const outStmts = [];
      for (const st of astNode.body) {
        if (!st || st.type !== 'ImportDecl') {
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
          if (!moduleCache[targetFile]) {
            visiting.add(targetFile);
            const mAst = parse(filesMap[targetFile].content, targetFile);
            (mAst.assetBlocks || []).forEach(ab => collectedAssets.push(...ab.entries));
            const resolvedBody = resolveAstImports(mAst, targetFile, false);
            visiting.delete(targetFile);
            const exportsList = collectExportsFromBody(mAst.body);
            const modVar = `__royMod_${++modSeq}`;
            moduleCache[targetFile] = { modVar, exportsList };
            outStmts.push({ type: 'ModuleScope', modVar, body: resolvedBody, exportsList, line: st.line, col: st.col });
          }
          const cached = moduleCache[targetFile];
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
      gameHeader: entryAst.gameHeader,
      body: entryResolvedStmts
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
      assets: uniqueAssets.map(a => ({ alias: a.alias, path: a.path })),
      lineCount: src.split('\n').length
    };
  }

  function compileToHtml(source, gameMeta, projectFiles = null, entryPath = 'main.roy') {
    const compiled = compile(source, projectFiles, entryPath);
    const m = compiled.meta;
    const titleStr = (m && m.title) || (gameMeta && gameMeta.title) || 'RoyLang Game';
    const safeCode = compiled.jsCode.replace(/<\/script/gi, '<\\/script');
    const safeAssetsJson = JSON.stringify(compiled.assets || []).replace(/<\/script/gi, '<\\/script');
    const bgStr = String(m.bg || '#090d16');
    const w = Number(m.width) || 800;
    const h = Number(m.height) || 500;
    const pixelated = !!m.pixelated;

    return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${_royEscapeHtml(titleStr)}</title>
  <style>
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: 100%; height: 100%; background: #050811; overflow: hidden; display: flex; align-items: center; justify-content: center; font-family: system-ui, -apple-system, sans-serif; color: #f8fafc; }
#royCanvas {
  display: block;
  max-width: 100vw;
  max-height: 100vh;
  width: auto;
  height: auto;
  aspect-ratio: ${w} / ${h};
  background: ${bgStr};
  box-shadow: 0 14px 44px rgba(0,0,0,0.65);
  border-radius: 6px;
  ${pixelated ? 'image-rendering: pixelated;' : ''}
}
  </style>
</head>
<body>
  <canvas id="royCanvas" width="${w}" height="${h}"></canvas>
  <script>
(function() {
  var canvas = document.getElementById('royCanvas');
  var ctx = canvas.getContext('2d');
  var W = ${w}, H = ${h}, BG = ${JSON.stringify(bgStr)};
  var ASSET_MANIFEST = ${safeAssetsJson};
  var hooks = { start: [], update: [], draw: [], keydown: [], keyup: [], click: [], pointermove: [], wheel: [] };
  var sceneHooks = {};
  var timers = [];
  var afterTimers = [];
  var tweens = [];
  var worldEntities = [];
  var entitiesDrawnThisFrame = false;
  var keysDown = {};
  var keysJustPressed = {};
  var mouse = { x: W / 2, y: H / 2, rx: W / 2, ry: H / 2, down: false, clicked: false, justReleased: false, wheel: 0 };
  var particlePool = [];
  var cam = { x: 0, y: 0, zoom: 1, shakePow: 0, shakeDur: 0, shakeTime: 0, followTarget: null, followSmooth: 8 };
  var freezeRem = 0;
  var flashState = { color: '#ffffff', rem: 0, dur: 0 };
  var currentScene = 'main';
  var sceneTime = 0;
  var sceneFrame = 0;
  var inDraw = false;
  var gameTime = 0;
  var currentFps = 60;
  var audioCtx = null;
  var loopCounter = 0;
  var telemetryTimer = 0;

  function __royLoopTick() {
    if (++loopCounter > 250000) throw new Error('Превышен лимит итераций цикла за кадр');
  }

  function emitConsole(level, text) {
    try {
      window.parent.postMessage({ type: 'roystudio-console', level: level, text: String(text) }, '*');
    } catch(e) {}
  }

  function handleHookError(err) {
    emitConsole('error', err && err.message ? err.message : String(err));
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

  function tone(freq, durMsOrSec, wave) {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!audioCtx) audioCtx = new Ctx();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      var f = noteToFreq(freq);
      var rawD = Number(durMsOrSec) || 0.12;
      var dur = rawD > 5 ? rawD / 1000 : rawD;
      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      osc.type = wave || 'square';
      osc.frequency.setValueAtTime(f, audioCtx.currentTime);
      gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + Math.max(0.02, dur));
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + Math.max(0.02, dur));
    } catch(e) {}
  }

  function melody(notes, stepMs, wave) {
    if (!Array.isArray(notes)) return;
    var step = Number(stepMs) || 140;
    notes.forEach(function(n, idx) {
      if (!n || n === '-' || n === '_') return;
      setTimeout(function() { tone(n, Math.max(0.05, (step * 0.85) / 1000), wave || 'triangle'); }, idx * step);
    });
  }

  function sfx(name) {
    var n = String(name || '').toLowerCase();
    if (n === 'coin') { tone(987, 0.08, 'sine'); setTimeout(function(){ tone(1318, 0.12, 'sine'); }, 55); }
    else if (n === 'jump') { tone(320, 0.09, 'triangle'); setTimeout(function(){ tone(520, 0.1, 'triangle'); }, 45); }
    else if (n === 'hit' || n === 'hurt') { tone(140, 0.16, 'sawtooth'); }
    else if (n === 'laser' || n === 'shoot') { tone(880, 0.06, 'sawtooth'); setTimeout(function(){ tone(420, 0.08, 'sawtooth'); }, 35); }
    else if (n === 'explosion' || n === 'boom') { tone(95, 0.24, 'sawtooth'); setTimeout(function(){ tone(60, 0.28, 'square'); }, 60); }
    else if (n === 'powerup') { melody(['C5','E5','G5','C6'], 65, 'triangle'); }
    else if (n === 'win') { melody(['C5','E5','G5','C6'], 90, 'sine'); }
    else { tone(620, 0.05, 'sine'); }
  }

  function loadImageAsset(path, onDone) {
    var img = new Image();
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
    img.src = String(path || '');
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

  function drawRect(x, y, w, h, color, radius) {
    ctx.fillStyle = color || '#38bdf8';
    if (radius && radius > 0 && ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, radius);
      ctx.fill();
    } else {
      ctx.fillRect(x, y, w, h);
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

  function button(label, x, y, w, h, col, hoverCol, textCol, radius) {
    var bw = Number(w) || 160, bh = Number(h) || 44;
    var mx = mouse.x, my = mouse.y;
    var hov = mx >= x && mx <= x + bw && my >= y && my <= y + bh;
    var rad = radius === undefined ? 8 : radius;
    drawRect(x, y, bw, bh, hov ? (hoverCol || '#2563eb') : (col || '#1e293b'), rad);
    ctx.strokeStyle = hov ? '#93c5fd' : 'rgba(148,163,184,0.35)';
    ctx.lineWidth = hov ? 2 : 1;
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, bw, bh, rad); ctx.stroke(); }
    else { ctx.strokeRect(x, y, bw, bh); }
    ctx.fillStyle = textCol || '#f8fafc';
    ctx.font = '800 ' + Math.max(12, Math.min(20, Math.floor(bh * 0.42))) + 'px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(label || ''), x + bw / 2, y + bh / 2);
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    return hov && mouse.clicked;
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
    var r = Math.max(0, Math.min(1, Number(ratio) || 0));
    drawRect(x, y, w, h, bgCol || 'rgba(15,23,42,0.85)', radius || 4);
    if (r > 0) drawRect(x, y, w * r, h, fillCol || '#34d399', radius || 4);
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
    ctx.fillStyle = color || '#f8fafc';
    ctx.font = '700 ' + (Number(size) || 18) + 'px system-ui, -apple-system, sans-serif';
    ctx.textAlign = align || 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(String(str === undefined ? '' : str), x, y);
  }

  function textStroke(str, x, y, color, strokeColor, size, align, lw) {
    var s = String(str === undefined ? '' : str);
    ctx.font = '800 ' + (Number(size) || 20) + 'px system-ui, -apple-system, sans-serif';
    ctx.textAlign = align || 'left';
    ctx.textBaseline = 'top';
    ctx.lineJoin = 'round';
    ctx.lineWidth = lw || 4;
    ctx.strokeStyle = strokeColor || '#020617';
    ctx.strokeText(s, x, y);
    ctx.fillStyle = color || '#f8fafc';
    ctx.fillText(s, x, y);
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
  }
  BaseEntity.prototype.move = function(dx, dy) { this.x += dx || 0; this.y += dy || 0; };
  BaseEntity.prototype.destroy = function() { this.alive = false; };
  BaseEntity.prototype.collides = function(other) { return collides(this, other); };
  BaseEntity.prototype.distTo = function(other) { return other ? Math.hypot((other.x || 0) - this.x, (other.y || 0) - this.y) : Infinity; };
  BaseEntity.prototype.contains = function(px, py) {
    if (this._shape === 'circle') { var dx = px - this.x, dy = py - this.y; return dx * dx + dy * dy <= (this.r || 16) * (this.r || 16); }
    return px >= this.x && px <= this.x + (this.w || 32) && py >= this.y && py <= this.y + (this.h || 32);
  };
  BaseEntity.prototype.draw = function() {
    ctx.save();
    if (this.alpha !== undefined && this.alpha !== 1) ctx.globalAlpha *= Math.max(0, Math.min(1, this.alpha));
    if (this._shape === 'circle') drawCircle(this.x, this.y, this.r || 16, this.color || '#fbbf24');
    else drawRect(this.x, this.y, this.w || 32, this.h || 32, this.color || '#38bdf8');
    ctx.restore();
  };

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

  function spawnParticles(x, y, color, count, speedMax) {
    var n = Math.min(80, Number(count) || 12);
    var sm = Number(speedMax) || 180;
    for (var i = 0; i < n; i++) {
      var ang = Math.random() * Math.PI * 2;
      var spd = 40 + Math.random() * sm;
      particlePool.push({
        x: x, y: y,
        vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd,
        life: 0.35 + Math.random() * 0.45, maxLife: 0.8,
        size: 2 + Math.random() * 3.5,
        color: color || '#fbbf24'
      });
    }
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
        resolve: resolve
      });
    });
  }

  function gotoScene(nextName, payload) {
    var nxt = String(nextName || 'main');
    var old = currentScene;
    if (old !== nxt && sceneHooks['exit:' + old]) {
      sceneHooks['exit:' + old].forEach(function(fn) {
        loopCounter = 0;
        Promise.resolve(fn(payload)).catch(handleHookError);
      });
    }
    currentScene = nxt;
    sceneTime = 0;
    sceneFrame = 0;
    if (sceneHooks['enter:' + nxt]) {
      sceneHooks['enter:' + nxt].forEach(function(fn) {
        loopCounter = 0;
        Promise.resolve(fn(payload)).catch(handleHookError);
      });
    }
  }

  function drawEntitiesNow(filterTag) {
    entitiesDrawnThisFrame = true;
    for (var i = 0; i < worldEntities.length; i++) {
      var ent = worldEntities[i];
      if (!ent || ent.alive === false) continue;
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
    width: W, height: H, bg: BG,
    get time() { return gameTime; },
    get fps() { return currentFps; },
    clear: function(c) { ctx.fillStyle = c || gameObj.bg; ctx.fillRect(0, 0, W, H); }
  };

  var sceneObj = {
    get name() { return currentScene; },
    get time() { return sceneTime; },
    get frame() { return sceneFrame; },
    is: function(n) { return currentScene === n; },
    goto: gotoScene
  };

  var __rt = {
    _assets: {},
    BaseEntity: BaseEntity,
    spawn: function(ent) {
      if (ent && typeof ent === 'object') {
        if (ent.alive === undefined) ent.alive = true;
        worldEntities.push(ent);
      }
      return ent;
    },
    entities: function(tagName) {
      return worldEntities.filter(function(e) { return e && e.alive !== false && (!tagName || e.tag === tagName); });
    },
    destroyAll: function(tagName) {
      worldEntities.forEach(function(e) { if (e && (!tagName || e.tag === tagName)) e.alive = false; });
    },
    drawEntities: drawEntitiesNow,
    on: function(ev, fn) {
      if (String(ev).indexOf('enter:') === 0 || String(ev).indexOf('exit:') === 0) {
        if (!sceneHooks[ev]) sceneHooks[ev] = [];
        sceneHooks[ev].push(fn);
      } else if (hooks[ev]) {
        hooks[ev].push(fn);
      }
    },
    every: function(ms, fn) { timers.push({ interval: Math.max(0.016, (Number(ms) || 1000) / 1000), acc: 0, fn: fn }); },
    after: function(ms, fn) { afterTimers.push({ rem: Math.max(0.001, (Number(ms) || 0) / 1000), fn: fn }); },
    wait: function(ms) { return new Promise(function(res){ setTimeout(res, Math.max(0, Number(ms) || 0)); }); },
    loadImage: function(p) { return loadImageAsset(p); },
    loadSound: function(p) { return loadSoundAsset(p); },
    loadJson: function(p) { return loadJsonAsset(p); },
    tilemap: tilemap,
    moveAndCollide: moveAndCollide,
    raycast: raycast,
    button: button,
    drawGradient: drawGradient,
    freezeFrame: function(ms) { var d = Number(ms) || 60; freezeRem = Math.max(freezeRem, d > 10 ? d / 1000 : d); },
    flashScreen: function(col, ms) { var d = Number(ms) || 180; flashState.color = col || '#ffffff'; flashState.dur = d > 10 ? d / 1000 : d; flashState.rem = flashState.dur; },
    scene: sceneObj,
    goto: gotoScene,
    tween: addTween,
    vec: vec,
    sprite: sprite,
    game: gameObj,
    mouse: mouse,
    player: sdk.player.getSync(),
    RoySDK: sdk,
    world: sdk.world,
    rooms: sdk.rooms,
    save: function(k, v) { return sdk.storage.set(k, v); },
    load: function(k, d) { return sdk.storage.get(k, d); },
    submitScore: function(sc, opts) { return sdk.leaderboard.submit(sc, opts || { mode: 'best' }); },
    topScores: function(lim) { return sdk.leaderboard.getTop(lim || 15); },
    toast: function(m, t) { return sdk.ui.toast(m, t); },
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
    drawLine: drawLine,
    drawPoly: drawPoly,
    drawStar: drawStar,
    drawBar: drawBar,
    drawGrid: drawGrid,
    pixel: function(x, y, size, color) { drawRect(x, y, size || 10, size || 10, color); },
    text: text,
    textStroke: textStroke,
    glow: function(col, blur) { ctx.shadowColor = col || '#38bdf8'; ctx.shadowBlur = Number(blur) || 14; },
    resetGlow: function() { ctx.shadowBlur = 0; ctx.shadowColor = 'transparent'; },
    alpha: function(a) { ctx.globalAlpha = Math.max(0, Math.min(1, Number(a))); },
    blend: function(mode) { ctx.globalCompositeOperation = mode || 'source-over'; },
    particles: spawnParticles,
    camera: function(x, y, zoom) { cam.x = Number(x) || 0; cam.y = Number(y) || 0; cam.zoom = Number(zoom) || 1; cam.followTarget = null; },
    cameraFollow: function(target, smooth) { cam.followTarget = target || null; if (smooth !== undefined) cam.followSmooth = Number(smooth) || 8; },
    shake: function(power, durMs) { cam.shakePow = Math.max(cam.shakePow, Number(power) || 8); var d = Number(durMs) || 250; cam.shakeDur = d > 10 ? d / 1000 : d; cam.shakeTime = cam.shakeDur; },
    key: function(code) { return !!keysDown[code] || !!keysDown[String(code).toLowerCase()]; },
    keyPressed: function(code) { return !!keysJustPressed[code] || !!keysJustPressed[String(code).toLowerCase()]; },
    axis: function(dir) {
      var d = String(dir || 'horizontal').toLowerCase();
      if (d === 'x' || d === 'horizontal' || d === 'h') {
        var l = keysDown['ArrowLeft'] || keysDown['KeyA'] || keysDown['a'];
        var r = keysDown['ArrowRight'] || keysDown['KeyD'] || keysDown['d'];
        return (r ? 1 : 0) - (l ? 1 : 0);
      }
      var u = keysDown['ArrowUp'] || keysDown['KeyW'] || keysDown['w'];
      var dn = keysDown['ArrowDown'] || keysDown['KeyS'] || keysDown['s'];
      return (dn ? 1 : 0) - (u ? 1 : 0);
    },
    sfx: sfx,
    tone: tone,
    playNote: tone,
    melody: melody,
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
    sin: Math.sin, cos: Math.cos, atan2: Math.atan2, sqrt: Math.sqrt, pow: Math.pow,
    floor: Math.floor, ceil: Math.ceil, round: Math.round,
    int: function(v) { return parseInt(v, 10) || 0; },
    float: function(v) { return parseFloat(v) || 0; },
    str: function(v) { return String(v === undefined || v === null ? '' : v); },
    rand: function(a, b) { if (b === undefined) { b = a === undefined ? 1 : a; a = 0; } return a + Math.random() * (b - a); },
    randInt: function(a, b) { if (b === undefined) { b = a; a = 0; } return Math.floor(a + Math.random() * (b - a + 1)); },
    choose: function(arr) { return Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : null; },
    len: function(v) { if (Array.isArray(v) || typeof v === 'string') return v.length; if (v && typeof v === 'object') return Object.keys(v).length; return 0; },
    push: function(arr, v) { if (Array.isArray(arr)) arr.push(v); return arr; },
    pop: function(arr) { return Array.isArray(arr) ? arr.pop() : null; },
    removeAt: function(arr, idx) { if (Array.isArray(arr) && idx >= 0 && idx < arr.length) return arr.splice(idx, 1)[0]; return null; },
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
    return {
      x: sx, y: sy,
      rx: (sx - W / 2) / (cam.zoom || 1) + W / 2 + cam.x,
      ry: (sy - H / 2) / (cam.zoom || 1) + H / 2 + cam.y
    };
  }

  window.addEventListener('keydown', function(e) {
    if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space',' '].indexOf(e.key) >= 0) e.preventDefault();
    if (!keysDown[e.code]) { keysJustPressed[e.code] = true; keysJustPressed[e.key.toLowerCase()] = true; }
    keysDown[e.code] = true; keysDown[e.key] = true; keysDown[e.key.toLowerCase()] = true;
    hooks.keydown.forEach(function(fn) { loopCounter = 0; Promise.resolve(fn(e.key)).catch(handleHookError); });
  });

  window.addEventListener('keyup', function(e) {
    delete keysDown[e.code]; delete keysDown[e.key]; delete keysDown[e.key.toLowerCase()];
    hooks.keyup.forEach(function(fn) { loopCounter = 0; Promise.resolve(fn(e.key)).catch(handleHookError); });
  });

  canvas.addEventListener('mousemove', function(e) {
    var p = canvasCoords(e);
    mouse.x = p.x; mouse.y = p.y; mouse.rx = p.rx; mouse.ry = p.ry;
    hooks.pointermove.forEach(function(fn) { loopCounter = 0; Promise.resolve(fn(p.x, p.y)).catch(handleHookError); });
  });

  canvas.addEventListener('mousedown', function(e) {
    var p = canvasCoords(e);
    mouse.x = p.x; mouse.y = p.y; mouse.rx = p.rx; mouse.ry = p.ry;
    mouse.down = true; mouse.clicked = true;
    hooks.click.forEach(function(fn) { loopCounter = 0; Promise.resolve(fn(p.x, p.y, e.button)).catch(handleHookError); });
  });

  window.addEventListener('mouseup', function() { if (mouse.down) mouse.justReleased = true; mouse.down = false; });

  canvas.addEventListener('wheel', function(e) {
    e.preventDefault();
    mouse.wheel = e.deltaY;
    hooks.wheel.forEach(function(fn) { loopCounter = 0; Promise.resolve(fn(e.deltaY)).catch(handleHookError); });
  }, { passive: false });

  var userProgramFn = new Function('__rt', 'RoySDK', '__royLoopTick',
    'with (__rt) {\\n' +
    'return (async function(){\\n' +
    ${JSON.stringify(safeCode)} +
    '\\n})();\\n' +
    '}'
  );

  var lastTs = performance.now();
  var fpsFrames = 0, fpsAcc = 0;

  function frameLoop(now) {
    var dt = Math.min(0.05, Math.max(0.001, (now - lastTs) / 1000));
    lastTs = now;
    fpsFrames++; fpsAcc += dt;
    if (fpsAcc >= 0.5) { currentFps = Math.round(fpsFrames / fpsAcc); fpsFrames = 0; fpsAcc = 0; }
    telemetryTimer += dt;
    if (telemetryTimer >= 0.35) {
      telemetryTimer = 0;
      try { window.parent.postMessage({ type: 'roystudio-telemetry', fps: currentFps, scene: currentScene, entities: worldEntities.length }, '*'); } catch(e) {}
    }

    var frozen = false;
    if (freezeRem > 0) {
      freezeRem = Math.max(0, freezeRem - dt);
      frozen = true;
    }

    if (!frozen) {
      gameTime += dt;
      sceneTime += dt;
      sceneFrame++;
      loopCounter = 0;
      for (var ai = afterTimers.length - 1; ai >= 0; ai--) {
        afterTimers[ai].rem -= dt;
        if (afterTimers[ai].rem <= 0) {
          var aft = afterTimers.splice(ai, 1)[0];
          Promise.resolve(aft.fn()).catch(handleHookError);
        }
      }
      for (var ti = 0; ti < timers.length; ti++) {
        timers[ti].acc += dt;
        while (timers[ti].acc >= timers[ti].interval) {
          timers[ti].acc -= timers[ti].interval;
          Promise.resolve(timers[ti].fn()).catch(handleHookError);
        }
      }
      for (var twi = tweens.length - 1; twi >= 0; twi--) {
        var tw = tweens[twi];
        tw.t += dt / tw.dur;
        var k = Math.min(1, tw.t);
        tw.obj[tw.prop] = tw.from + (tw.to - tw.from) * tw.ease(k);
        if (k >= 1) { tweens.splice(twi, 1); tw.resolve(tw.obj); }
      }
      for (var ei = 0; ei < worldEntities.length; ei++) {
        var ent = worldEntities[ei];
        if (ent && ent.alive !== false && typeof ent.update === 'function') {
          Promise.resolve(ent.update(dt)).catch(handleHookError);
        }
      }
      for (var ui = 0; ui < hooks.update.length; ui++) {
        Promise.resolve(hooks.update[ui](dt)).catch(handleHookError);
      }
      for (var er = worldEntities.length - 1; er >= 0; er--) {
        if (!worldEntities[er] || worldEntities[er].alive === false) worldEntities.splice(er, 1);
      }
      for (var pi = particlePool.length - 1; pi >= 0; pi--) {
        var pt = particlePool[pi];
        pt.x += pt.vx * dt; pt.y += pt.vy * dt; pt.life -= dt;
        if (pt.life <= 0) particlePool.splice(pi, 1);
      }
    }

    if (cam.followTarget) {
      var tx = (cam.followTarget.x || 0) - W / 2;
      var ty = (cam.followTarget.y || 0) - H / 2;
      var alphaCam = Math.min(1, dt * cam.followSmooth);
      cam.x += (tx - cam.x) * alphaCam;
      cam.y += (ty - cam.y) * alphaCam;
    }
    var shakeOx = 0, shakeOy = 0;
    if (cam.shakeTime > 0) {
      cam.shakeTime = Math.max(0, cam.shakeTime - dt);
      var decay = cam.shakeDur > 0 ? cam.shakeTime / cam.shakeDur : 0;
      var mag = cam.shakePow * decay;
      shakeOx = (Math.random() * 2 - 1) * mag;
      shakeOy = (Math.random() * 2 - 1) * mag;
    } else { cam.shakePow = 0; }

    ctx.save();
    ctx.shadowBlur = 0; ctx.shadowColor = 'transparent'; ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    gameObj.clear();
    if (cam.zoom !== 1 || cam.x !== 0 || cam.y !== 0 || shakeOx !== 0 || shakeOy !== 0) {
      ctx.translate(W / 2 + shakeOx, H / 2 + shakeOy);
      ctx.scale(cam.zoom, cam.zoom);
      ctx.translate(-W / 2 - cam.x, -H / 2 - cam.y);
    }
    entitiesDrawnThisFrame = false;
    inDraw = true;
    for (var di = 0; di < hooks.draw.length; di++) {
      loopCounter = 0;
      Promise.resolve(hooks.draw[di]()).catch(handleHookError);
    }
    if (!entitiesDrawnThisFrame && worldEntities.length > 0) {
      drawEntitiesNow();
    }
    inDraw = false;
    ctx.shadowBlur = 0; ctx.shadowColor = 'transparent'; ctx.globalCompositeOperation = 'source-over';
    for (var pj = 0; pj < particlePool.length; pj++) {
      var q = particlePool[pj];
      ctx.globalAlpha = Math.max(0, q.life / q.maxLife);
      ctx.fillStyle = q.color;
      ctx.fillRect(q.x - q.size / 2, q.y - q.size / 2, q.size, q.size);
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    if (flashState.rem > 0) {
      flashState.rem = Math.max(0, flashState.rem - dt);
      ctx.save();
      ctx.globalAlpha = flashState.dur > 0 ? Math.min(0.85, flashState.rem / flashState.dur) : 0;
      ctx.fillStyle = flashState.color || '#ffffff';
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }

    keysJustPressed = {};
    mouse.clicked = false;
    mouse.justReleased = false;
    mouse.wheel = 0;
    requestAnimationFrame(frameLoop);
  }

  preloadManifestAssets(ASSET_MANIFEST).then(function(assetObj) {
    __rt._assets = assetObj || {};
    return Promise.resolve(userProgramFn(__rt, sdk, __royLoopTick));
  }).then(function() {
    var sList = hooks.start.slice();
    var chain = Promise.resolve();
    sList.forEach(function(fn) {
      chain = chain.then(function(){ loopCounter = 0; return fn(); });
    });
    return chain;
  }).then(function() {
    lastTs = performance.now();
    requestAnimationFrame(frameLoop);
  }).catch(function(err) {
    emitConsole('error', err && err.message ? err.message : String(err));
    ctx.fillStyle = '#090d16';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#f87171';
    ctx.font = '700 18px system-ui, sans-serif';
    ctx.fillText('Ошибка RoyLang: ' + (err && err.message ? err.message : err), 20, 32);
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
