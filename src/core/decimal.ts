interface Decimal {
    coefficient: bigint;
    scale: number;
}

function parse(value: string): Decimal {
    const match = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value);
    if (!match || value.length > 1000)
        throw new Error("invalid_decimal: Expected a bounded decimal lexeme");
    const exponent = Number(match[4] ?? "0");
    if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000)
        throw new Error("invalid_decimal: Exponent is too large");
    const fraction = match[3] ?? "";
    let coefficient = BigInt(
        `${match[1] === "-" ? "-" : ""}${match[2]}${fraction}`,
    );
    let scale = fraction.length - exponent;
    if (scale < 0) {
        coefficient *= 10n ** BigInt(-scale);
        scale = 0;
    }
    return { coefficient, scale };
}

function format({ coefficient, scale }: Decimal): string {
    const negative = coefficient < 0n;
    let digits = (negative ? -coefficient : coefficient)
        .toString()
        .padStart(scale + 1, "0");
    if (scale > 0)
        digits = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(
            /\.?0+$/,
            "",
        );
    return `${negative && coefficient !== 0n ? "-" : ""}${digits}`;
}

export function decimal(value: string): string {
    return format(parse(value));
}
export function addDecimal(a: string, b: string): string {
    const left = parse(a),
        right = parse(b),
        scale = Math.max(left.scale, right.scale);
    return format({
        coefficient:
            left.coefficient * 10n ** BigInt(scale - left.scale) +
            right.coefficient * 10n ** BigInt(scale - right.scale),
        scale,
    });
}
export function compareDecimal(a: string, b: string): number {
    const normalized = decimal(b);
    const diff = addDecimal(
        a,
        normalized.startsWith("-") ? normalized.slice(1) : `-${normalized}`,
    );
    return diff === "0" ? 0 : diff.startsWith("-") ? -1 : 1;
}
export function sumDecimals(values: readonly string[]): string {
    return values.reduce(addDecimal, "0");
}
