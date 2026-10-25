export const PAIR_MINIMUM_PAYOUT_MULTIPLIER = 8;

export const isHigherLowerPair = contractTypes =>
    Array.isArray(contractTypes) &&
    contractTypes.length === 2 &&
    new Set(contractTypes).size === 2 &&
    contractTypes.includes('HIGHER') &&
    contractTypes.includes('LOWER');

export const requiresProposalForTrade = (contractTypes, hasPayoutBlock, isBasisPayout) =>
    hasPayoutBlock || isBasisPayout || isHigherLowerPair(contractTypes);

const toFiniteNumber = value => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (typeof value !== 'string' || value.trim() === '') return undefined;

    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
};

const toDecimal = value => {
    if (toFiniteNumber(value) === undefined) return undefined;

    const text = String(value).trim();
    const match = text.match(/^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i);
    if (!match) return undefined;

    const sign = match[1] === '-' ? -1n : 1n;
    const fraction = match[3] || '';
    const exponent = Number(match[4] || 0);
    if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) return undefined;
    let coefficient = BigInt(`${match[2]}${fraction}`) * sign;
    let scale = fraction.length - exponent;

    if (scale < 0) {
        coefficient *= 10n ** BigInt(-scale);
        scale = 0;
    }

    return { coefficient, scale };
};

const formatDecimal = ({ coefficient, scale }) => {
    const isNegative = coefficient < 0;
    let digits = (isNegative ? -coefficient : coefficient).toString();

    if (scale > 0) {
        digits = digits.padStart(scale + 1, '0');
        const integer = digits.slice(0, -scale);
        const fraction = digits.slice(-scale).replace(/0+$/, '');
        digits = fraction ? `${integer}.${fraction}` : integer;
    }

    return `${isNegative ? '-' : ''}${digits}`;
};

export const getMinimumPairPayout = stake => {
    const decimalStake = toDecimal(stake);
    if (!decimalStake || decimalStake.coefficient <= 0) return undefined;

    return formatDecimal({
        coefficient: decimalStake.coefficient * BigInt(PAIR_MINIMUM_PAYOUT_MULTIPLIER),
        scale: decimalStake.scale,
    });
};

const payoutMeetsMinimum = (payout, stake) => {
    const payoutDecimal = toDecimal(payout);
    const stakeDecimal = toDecimal(stake);
    if (!payoutDecimal || !stakeDecimal) return false;

    const scale = Math.max(payoutDecimal.scale, stakeDecimal.scale);
    const payoutUnits = payoutDecimal.coefficient * 10n ** BigInt(scale - payoutDecimal.scale);
    const stakeUnits = stakeDecimal.coefficient * 10n ** BigInt(scale - stakeDecimal.scale);

    return payoutUnits >= stakeUnits * BigInt(PAIR_MINIMUM_PAYOUT_MULTIPLIER);
};

const requiredPayoutText = (minimumPayout, currency) =>
    `Required payout per contract: ${minimumPayout} ${currency || ''}.`.trim();

export const validatePairPayouts = ({ proposals, purchaseReference, stake, currency }) => {
    const numericStake = toFiniteNumber(stake);
    const minimumPayoutText = getMinimumPairPayout(stake);
    if (numericStake === undefined || numericStake <= 0 || minimumPayoutText === undefined) {
        throw new Error('Higher/Lower pair rejected: the current stake is missing or invalid.');
    }

    const pair = {};

    ['HIGHER', 'LOWER'].forEach(contractType => {
        const proposal = proposals?.find(
            item => item.contract_type === contractType && item.purchase_reference === purchaseReference
        );

        if (!proposal) {
            throw new Error(
                `Higher/Lower pair rejected: the current ${contractType} quote is unavailable. ${requiredPayoutText(minimumPayoutText, currency)}`
            );
        }
        if (proposal.error) {
            const detail = proposal.error?.error?.message || proposal.error?.message || 'Deriv marked the quote as invalid';
            throw new Error(
                `Higher/Lower pair rejected: ${contractType} quote is invalid (${detail}). ${requiredPayoutText(minimumPayoutText, currency)}`
            );
        }
        if (!proposal.id || toFiniteNumber(proposal.ask_price) === undefined || toFiniteNumber(proposal.ask_price) <= 0) {
            throw new Error(
                `Higher/Lower pair rejected: ${contractType} quote is missing a valid proposal id or ask price. ${requiredPayoutText(minimumPayoutText, currency)}`
            );
        }

        const payout = proposal.payout;
        const numericPayout = toFiniteNumber(payout);
        if (numericPayout === undefined || numericPayout < 0) {
            throw new Error(
                `Higher/Lower pair rejected: ${contractType} quote has no valid payout. ${requiredPayoutText(minimumPayoutText, currency)}`
            );
        }
        if (!payoutMeetsMinimum(payout, stake)) {
            throw new Error(
                `Higher/Lower pair rejected: ${contractType} payout ${String(payout)} ${currency || ''} is below the required ${minimumPayoutText} ${currency || ''}.`.trim()
            );
        }

        pair[contractType] = proposal;
    });

    return pair;
};

export const withValidatedPairProposals = (options, startPairPurchase) => {
    const pair = validatePairPayouts(options);
    return startPairPurchase(pair);
};
