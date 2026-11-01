export interface Fix {
  startCol: number; // с какого символа заменяем
  endCol: number; // по какой символ (не включая)
  newText: string; // на что заменяем
}

export interface Finding {
  ruleId: string;
  title: string; // короткое название (для списка)
  message: string; // полное сообщение (для подсказки)
  fixTitle: string; // название исправления
  severity: 'warning' | 'info';
  line: number; // номер строки, считая с нуля
  startCol: number; // подсвечиваемый кусок
  endCol: number;
  fix: Fix;
}

interface Meta {
  title: string;
  message: string;
  fixTitle: string;
  severity: 'warning' | 'info';
}

const META: Record<string, Meta> = {
  'assign-in-if': {
    title: 'Присваивание вместо сравнения',
    message: 'Мяу! Здесь присваивание (=) вместо сравнения. Скорее всего, нужно ==',
    fixTitle: 'Заменить = на ==',
    severity: 'warning',
  },
  'int-size-loop': {
    title: 'int в цикле по size()',
    message: 'Мяу! size() возвращает беззнаковое число, а int — знаковое. Сравнение может сработать неправильно',
    fixTitle: 'Заменить int на size_t',
    severity: 'warning',
  },
  'endl': {
    title: 'std::endl',
    message: `Мур! std::endl каждый раз сбрасывает буфер и замедляет вывод. Лучше писать '\\n'`,
    fixTitle: `Заменить на '\\n'`,
    severity: 'info',
  },
  'semicolon-after-if': {
    title: 'Лишняя ; после if',
    message: 'Мяу! Точка с запятой сразу после if(...) делает тело условия пустым; блок ниже выполнится всегда',
    fixTitle: 'Удалить ;',
    severity: 'warning',
  },
  'redundant-true': {
    title: '== true',
    message: 'Мур! Сравнение с true лишнее. Достаточно написать само условие',
    fixTitle: 'Убрать == true',
    severity: 'info',
  },
};

function mk(
  id: string,
  line: number,
  startCol: number,
  endCol: number,
  newText: string,
  fixStart: number = startCol,
  fixEnd: number = endCol
): Finding {
  const m = META[id];
  return {
    ruleId: id,
    title: m.title,
    message: m.message,
    fixTitle: m.fixTitle,
    severity: m.severity,
    line,
    startCol,
    endCol,
    fix: { startCol: fixStart, endCol: fixEnd, newText },
  };
}

function maskLines(lines: string[]): string[] {
  let inBlock = false;
  return lines.map((line) => {
    let out = '';
    let i = 0;
    while (i < line.length) {
      if (inBlock) {
        if (line.startsWith('*/', i)) {
          inBlock = false;
          out += '  ';
          i += 2;
        } else {
          out += ' ';
          i++;
        }
      } else if (line.startsWith('/*', i)) {
        inBlock = true;
        out += '  ';
        i += 2;
      } else if (line.startsWith('//', i)) {
        out += ' '.repeat(line.length - i);
        break;
      } else if (line[i] === '"' || line[i] === "'") {
        const quote = line[i];
        out += quote;
        i++;
        while (i < line.length && line[i] !== quote) {
          const step = line[i] === '\\' && i + 1 < line.length ? 2 : 1;
          out += ' '.repeat(step);
          i += step;
        }
        if (i < line.length) {
          out += quote;
          i++;
        }
      } else {
        out += line[i];
        i++;
      }
    }
    return out;
  });
}

export function runRules(lines: string[], _fileName: string): Finding[] {
  const code = maskLines(lines);
  const found: Finding[] = [];

  code.forEach((line, i) => {
    // Правило: if (a = b) -> if (a == b)
    for (const m of line.matchAll(/\b(?:if|while)\s*\(\s*[\w.[\]]+\s*=(?!=)/g)) {
      const col = (m.index ?? 0) + m[0].length - 1;
      found.push(mk('assign-in-if', i, col, col + 1, '=='));
    }

    // Правило: for (int i = 0; i < v.size(); ...) -> size_t
    for (const m of line.matchAll(
      /\bfor\s*\(\s*int\s+\w+\s*=[^;]*;\s*\w+\s*<=?\s*[\w.[\]]*\.(?:size|length)\(\)/g
    )) {
      const col = (m.index ?? 0) + m[0].indexOf('int');
      found.push(mk('int-size-loop', i, col, col + 3, 'size_t'));
    }

    // Правило: endl -> '\n'
    for (const m of line.matchAll(/\b(?:std::)?endl\b/g)) {
      const start = m.index ?? 0;
      found.push(mk('endl', i, start, start + m[0].length, "'\\n'"));
    }

    // Правило: if (...); - лишняя точка с запятой
    for (const m of line.matchAll(/\bif\s*\(/g)) {
      const open = (m.index ?? 0) + m[0].length - 1;
      let depth = 0;
      let close = -1;
      for (let k = open; k < line.length; k++) {
        if (line[k] === '(') {
            depth++;
        } else if (line[k] === ')') {
          depth--;
          if (depth === 0) { close = k; break; }
        }
      }
      if (close === -1) {
        continue;
      }
      const semi = /^\s*;/.exec(line.slice(close + 1));
      if (semi) {
        const col = close + semi[0].length;
        found.push(mk('semicolon-after-if', i, col, col + 1, ''));
      }
    }

    // Правило: x == true -> x
    for (const m of line.matchAll(/\s*==\s*true\b/g)) {
      const start = m.index ?? 0;
      found.push(mk('redundant-true', i, start, start + m[0].length, ''));
    }
  });

  found.sort((a, b) => a.line - b.line || a.startCol - b.startCol);
  return found;
}