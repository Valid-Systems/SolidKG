import type {
  Node as NativeNode,
  Parser as NativeParser,
  Point as NativePoint,
  Tree as NativeTree,
} from '@xberg-io/tree-sitter-language-pack';

export type Point = Readonly<{
  row: number;
  column: number;
}>;

class SourceDocument {
  readonly text: string;
  private readonly lineStarts: readonly number[];
  private readonly byteColumnsByLine = new Map<number, ReadonlyMap<number, number> | null>();

  constructor(text: string) {
    this.text = text;
    const lineStarts = [0];
    for (let index = 0; index < text.length; index++) {
      if (text[index] === '\n') lineStarts.push(index + 1);
    }
    this.lineStarts = lineStarts;
  }

  indexAt(point: NativePoint): number {
    const lineStart = this.lineStarts[point.row] ?? this.text.length;
    const cachedColumns = this.byteColumnsByLine.get(point.row);
    const columns = cachedColumns === undefined
      ? this.createByteColumns(point.row, lineStart)
      : cachedColumns;
    if (columns === null) return lineStart + point.column;

    const utf16Column = columns.get(point.column);
    if (utf16Column === undefined) {
      throw new RangeError(`Invalid UTF-8 byte column ${point.column} on row ${point.row}`);
    }
    return lineStart + utf16Column;
  }

  positionAt(point: NativePoint): Point {
    const lineStart = this.lineStarts[point.row] ?? this.text.length;
    return {
      row: point.row,
      column: this.indexAt(point) - lineStart,
    };
  }

  private createByteColumns(row: number, lineStart: number): ReadonlyMap<number, number> | null {
    const lineEnd = this.lineStarts[row + 1] ?? this.text.length;
    const line = this.text.slice(lineStart, lineEnd);
    if (Buffer.byteLength(line) === line.length) {
      this.byteColumnsByLine.set(row, null);
      return null;
    }

    const columns = new Map<number, number>([[0, 0]]);
    let byteColumn = 0;
    let utf16Column = 0;
    for (const character of line) {
      byteColumn += Buffer.byteLength(character);
      utf16Column += character.length;
      columns.set(byteColumn, utf16Column);
    }
    this.byteColumnsByLine.set(row, columns);
    return columns;
  }
}

function sameNativeNode(left: NativeNode, right: NativeNode): boolean {
  return left.kindId() === right.kindId()
    && left.startByte() === right.startByte()
    && left.endByte() === right.endByte()
    && left.isNamed() === right.isNamed();
}

export class SyntaxNode {
  constructor(
    private readonly nativeNode: NativeNode,
    private readonly document: SourceDocument,
  ) {}

  get type(): string {
    return this.nativeNode.kind();
  }

  get startPosition(): Point {
    return this.document.positionAt(this.nativeNode.startPosition());
  }

  get endPosition(): Point {
    return this.document.positionAt(this.nativeNode.endPosition());
  }

  get startIndex(): number {
    return this.document.indexAt(this.nativeNode.startPosition());
  }

  get endIndex(): number {
    return this.document.indexAt(this.nativeNode.endPosition());
  }

  get text(): string {
    return this.document.text.slice(this.startIndex, this.endIndex);
  }

  get isNamed(): boolean {
    return this.nativeNode.isNamed();
  }

  get isExtra(): boolean {
    return this.nativeNode.isExtra();
  }

  get isError(): boolean {
    return this.nativeNode.isError();
  }

  get isMissing(): boolean {
    return this.nativeNode.isMissing();
  }

  get hasError(): boolean {
    return this.nativeNode.hasError();
  }

  get childCount(): number {
    return this.nativeNode.childCount();
  }

  get namedChildCount(): number {
    return this.nativeNode.namedChildCount();
  }

  get children(): SyntaxNode[] {
    return Array.from({ length: this.childCount }, (_, index) => this.child(index))
      .filter((node): node is SyntaxNode => node !== null);
  }

  get namedChildren(): SyntaxNode[] {
    return Array.from({ length: this.namedChildCount }, (_, index) => this.namedChild(index))
      .filter((node): node is SyntaxNode => node !== null);
  }

  get firstChild(): SyntaxNode | null {
    return this.child(0);
  }

  get firstNamedChild(): SyntaxNode | null {
    return this.namedChild(0);
  }

  get lastChild(): SyntaxNode | null {
    return this.child(this.childCount - 1);
  }

  get lastNamedChild(): SyntaxNode | null {
    return this.namedChild(this.namedChildCount - 1);
  }

  get parent(): SyntaxNode | null {
    return this.wrap(this.nativeNode.parent());
  }

  get previousSibling(): SyntaxNode | null {
    return this.sibling(-1, false);
  }

  get previousNamedSibling(): SyntaxNode | null {
    return this.sibling(-1, true);
  }

  get nextSibling(): SyntaxNode | null {
    return this.sibling(1, false);
  }

  get nextNamedSibling(): SyntaxNode | null {
    return this.sibling(1, true);
  }

  child(index: number): SyntaxNode | null {
    return index < 0 ? null : this.wrap(this.nativeNode.child(index));
  }

  namedChild(index: number): SyntaxNode | null {
    return index < 0 ? null : this.wrap(this.nativeNode.namedChild(index));
  }

  childForFieldName(fieldName: string): SyntaxNode | null {
    return this.wrap(this.nativeNode.childByFieldName(fieldName));
  }

  fieldNameForChild(index: number): string | null {
    return this.fieldNameAt(index, false);
  }

  fieldNameForNamedChild(index: number): string | null {
    return this.fieldNameAt(index, true);
  }

  toString(): string {
    return this.nativeNode.toSexp();
  }

  private wrap(node: NativeNode | null): SyntaxNode | null {
    return node === null ? null : new SyntaxNode(node, this.document);
  }

  private sibling(offset: -1 | 1, named: boolean): SyntaxNode | null {
    const parent = this.nativeNode.parent();
    if (parent === null) return null;
    const count = named ? parent.namedChildCount() : parent.childCount();
    for (let index = 0; index < count; index++) {
      const candidate = named ? parent.namedChild(index) : parent.child(index);
      if (candidate !== null && sameNativeNode(candidate, this.nativeNode)) {
        const siblingIndex = index + offset;
        if (siblingIndex < 0 || siblingIndex >= count) return null;
        return this.wrap(named ? parent.namedChild(siblingIndex) : parent.child(siblingIndex));
      }
    }
    return null;
  }

  private fieldNameAt(index: number, named: boolean): string | null {
    if (index < 0) return null;
    const cursor = this.nativeNode.walk();
    if (!cursor.gotoFirstChild()) return null;
    let currentIndex = 0;
    do {
      const current = cursor.node();
      if (!named || current.isNamed()) {
        if (currentIndex === index) return cursor.fieldName();
        currentIndex++;
      }
    } while (cursor.gotoNextSibling());
    return null;
  }
}

export class Tree {
  constructor(
    private readonly nativeTree: NativeTree,
    private readonly document: SourceDocument,
  ) {}

  get rootNode(): SyntaxNode {
    return new SyntaxNode(this.nativeTree.rootNode(), this.document);
  }

  delete(): void {}
}

export class Parser {
  constructor(private readonly nativeParser: NativeParser) {}

  parse(source: string): Tree | null {
    const nativeTree = this.nativeParser.parse(source);
    return nativeTree === null ? null : new Tree(nativeTree, new SourceDocument(source));
  }

  reset(): void {
    this.nativeParser.reset();
  }

  delete(): void {}
}

export { SyntaxNode as Node };
