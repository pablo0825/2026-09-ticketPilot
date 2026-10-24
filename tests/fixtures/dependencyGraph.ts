import { isBuiltin } from "node:module";
import { posix } from "node:path";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import {
    isCallExpression,
    isExportDeclaration,
    isExternalModuleReference,
    isIdentifier,
    isImportDeclaration,
    isImportEqualsDeclaration,
    isImportTypeNode,
    isLiteralTypeNode,
    isNoSubstitutionTemplateLiteral,
    isStringLiteral,
    SyntaxKind,
} from "typescript/unstable/ast";
import type { Node } from "typescript/unstable/ast";

interface Dependency {
    specifier: string | undefined;
    line: number;
}

function dependencies(source: Node, text: string): Dependency[] {
    const result: Dependency[] = [];
    function record(argument: Node | undefined, node: Node) {
        const specifier =
            argument && (isStringLiteral(argument) || isNoSubstitutionTemplateLiteral(argument))
                ? argument.text
                : undefined;
        result.push({ specifier, line: text.slice(0, node.getStart()).split("\n").length });
    }
    function visit(node: Node): void {
        if (isImportDeclaration(node) || isExportDeclaration(node)) {
            if (node.moduleSpecifier) record(node.moduleSpecifier, node);
        } else if (isImportEqualsDeclaration(node) && isExternalModuleReference(node.moduleReference)) {
            record(node.moduleReference.expression, node);
        } else if (isImportTypeNode(node)) {
            record(isLiteralTypeNode(node.argument) ? node.argument.literal : undefined, node);
        } else if (isCallExpression(node)) {
            if (
                node.expression.kind === SyntaxKind.ImportKeyword ||
                (isIdentifier(node.expression) && node.expression.text === "require")
            ) {
                record(node.arguments[0], node);
            }
        }
        node.forEachChild(visit);
    }
    visit(source);
    return result;
}

// 這些層會進入前端，型別引用也必須遵守相同方向。
const browserLayers = ["src/gui/", "src/shared/", "src/config/", "src/core/"];
const allowedLayers: Record<string, readonly string[]> = {
    "src/gui/": browserLayers,
    "src/shared/": ["src/shared/", "src/config/", "src/core/"],
    "src/config/": ["src/config/", "src/core/"],
    "src/core/": ["src/core/"],
    "src/app/platforms/": ["src/app/platforms/", "src/shared/", "src/config/", "src/core/"],
};

function allowedPackage(file: string, specifier: string): boolean {
    if (file.startsWith("src/gui/")) {
        return ["react", "react-dom/client", "react/jsx-runtime", "zod"].includes(specifier);
    }
    return specifier === "zod";
}

function resolveLocal(file: string, specifier: string, files: Readonly<Record<string, string>>): string | undefined {
    const target = posix.normalize(posix.join(posix.dirname(file), specifier));
    const candidates = [target, target.replace(/\.js$/, ".ts"), target.replace(/\.js$/, ".tsx")];
    return candidates.find(candidate => Object.hasOwn(files, candidate));
}

/** 檔名使用專案相對路徑；內容可來自真正 src 或隔離的負面測試。 */
export function dependencyViolations(files: Readonly<Record<string, string>>): string[] {
    const root = "/dependency-check";
    const sourceFiles = Object.keys(files).filter(file => /\.tsx?$/.test(file));
    const virtualFiles = Object.fromEntries(Object.entries(files).map(([file, text]) => [`${root}/${file}`, text]));
    const config = `${root}/tsconfig.json`;
    virtualFiles[config] = JSON.stringify({
        files: sourceFiles,
        compilerOptions: { noLib: true, noResolve: true, jsx: "preserve" },
    });
    const api = new API({ fs: createVirtualFileSystem(virtualFiles) });
    const graph = new Map<string, Dependency[]>();
    try {
        const snapshot = api.updateSnapshot({ openProjects: [config] });
        try {
            const project = snapshot.getProject(config);
            if (!project) throw new Error("Dependency parser project was not created");
            for (const file of sourceFiles) {
                const source = project.program.getSourceFile(`${root}/${file}`);
                if (!source) throw new Error(`Dependency parser did not load ${file}`);
                graph.set(file, dependencies(source, files[file] ?? ""));
            }
        } finally {
            snapshot.dispose();
        }
    } finally {
        api.close();
    }

    const violations = new Set<string>();
    function report(file: string, dependency: Dependency, reason: string) {
        violations.add(`${file}:${dependency.line}: ${dependency.specifier ?? "<computed import>"}: ${reason}`);
    }
    for (const [file, imports] of graph) {
        const layer = Object.keys(allowedLayers).find(prefix => file.startsWith(prefix));
        if (!layer) continue;
        for (const dependency of imports) {
            const { specifier } = dependency;
            if (specifier === undefined) {
                report(file, dependency, "module path must be a string literal");
            } else if (specifier.startsWith(".")) {
                const target = resolveLocal(file, specifier, files);
                if (!target) {
                    report(file, dependency, "local module does not exist");
                } else if (!allowedLayers[layer]?.some(prefix => target.startsWith(prefix))) {
                    report(file, dependency, "forbidden dependency layer");
                }
            } else if (isBuiltin(specifier) || !allowedPackage(file, specifier)) {
                report(file, dependency, "package is not allowed in this browser-free layer");
            }
        }
    }

    // new URL(worker, import.meta.url) 是子程序入口，不是主服務載入的模組。
    const visited = new Set<string>();
    function visitServer(file: string): void {
        if (visited.has(file)) return;
        visited.add(file);
        for (const dependency of graph.get(file) ?? []) {
            const { specifier } = dependency;
            if (specifier === undefined) {
                report(file, dependency, "server module path must be a string literal");
            } else if (/^(?:playwright|playwright-core|@playwright\/test)(?:\/|$)/.test(specifier)) {
                report(file, dependency, "server must not load Playwright");
            } else if (specifier.startsWith(".")) {
                const target = resolveLocal(file, specifier, files);
                if (!target) report(file, dependency, "local module does not exist");
                else visitServer(target);
            }
        }
    }
    visitServer("src/main.ts");
    visitServer("src/server/server.ts");
    visitServer("src/server/runs/purchaseRuns.ts");
    return [...violations].sort();
}
