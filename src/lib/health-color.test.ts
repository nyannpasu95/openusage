import { describe, expect, it } from "vitest"
import { getHealthColor, HEALTH_THRESHOLDS } from "@/lib/health-color"

describe("getHealthColor", () => {
  it("returns null below the amber threshold (defers to brand color)", () => {
    expect(getHealthColor(0)).toBeNull()
    expect(getHealthColor(74)).toBeNull()
  })

  it("turns amber at exactly the amber threshold", () => {
    expect(getHealthColor(HEALTH_THRESHOLDS.amber)).toBe("var(--yellow-500)")
    expect(getHealthColor(89)).toBe("var(--yellow-500)")
  })

  it("turns red at exactly the red threshold", () => {
    expect(getHealthColor(HEALTH_THRESHOLDS.red)).toBe("var(--red-500)")
    expect(getHealthColor(100)).toBe("var(--red-500)")
  })

  it("clamps out-of-range values", () => {
    expect(getHealthColor(150)).toBe("var(--red-500)")
    expect(getHealthColor(-50)).toBeNull()
  })

  it("treats non-finite input as 0% (healthy)", () => {
    expect(getHealthColor(Number.NaN)).toBeNull()
    expect(getHealthColor(Number.POSITIVE_INFINITY)).toBeNull()
    expect(getHealthColor(Number.NEGATIVE_INFINITY)).toBeNull()
  })
})
