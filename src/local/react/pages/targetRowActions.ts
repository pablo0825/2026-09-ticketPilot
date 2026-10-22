export interface TargetRowActions {
    onMoveUp: () => void;
    onMoveDown: () => void;
    onRemove: () => void;
    onDuplicate: () => void;
}

// 清單操作由頁面協調，平台只提供新增與複製時需要的完整欄位。
export function targetRowActions<T>(
    targets: T[],
    index: number,
    onChange: (targets: T[]) => void,
    emptyTarget: () => T,
    duplicateTarget: (target: T) => T,
): TargetRowActions {
    function move(offset: number) {
        const destination = index + offset;
        const source = targets[index];
        const other = targets[destination];
        if (source === undefined || other === undefined) return;
        const next = [...targets];
        next[index] = other;
        next[destination] = source;
        onChange(next);
    }
    return {
        onMoveUp: () => move(-1),
        onMoveDown: () => move(1),
        onRemove: () => onChange(targets.length === 1 ? [emptyTarget()] : targets.filter((_, i) => i !== index)),
        onDuplicate: () => {
            const target = targets[index];
            if (target === undefined) return;
            onChange([...targets.slice(0, index + 1), duplicateTarget(target), ...targets.slice(index + 1)]);
        },
    };
}
