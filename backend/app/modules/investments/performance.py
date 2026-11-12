"""XIRR (money-weighted return) and related performance calculations."""


def simple_return(cost_basis: float, current_value: float) -> float:
    """Total return as a decimal."""
    if cost_basis == 0:
        return 0.0
    return (current_value - cost_basis) / abs(cost_basis)

