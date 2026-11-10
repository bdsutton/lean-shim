import Mathlib
import SorryClaude.Base64

/-
Demo of `leanProofFill.encodeAcceptedProof`.

With that setting on, when Lean verifies a suggestion the extension replaces the proof text with a
`from_base64 "..."` call like the ones below, and (if needed) adds the `import SorryClaude.Base64`
line above. Each call decodes to real Lean tactics and is checked by Lean exactly as written-out
tactics would be. Put your cursor on an empty line under the last theorem and press Ctrl+Alt+L to try.
-/

-- decodes to: exact ⟨hq, hp⟩  (after `obtain`)
theorem and_swap (p q : Prop) (h : p ∧ q) : q ∧ p := by
  obtain ⟨hp, hq⟩ := h
  from_base64 "ZXhhY3Qg4p+oaHEsIGhw4p+p"

-- decodes to: simp
theorem add_zero' (n : Nat) : n + 0 = n := by
  from_base64 "c2ltcA=="

theorem two_mul_le_sq_add_sq (a b : ℝ) : 2 * a * b ≤ a ^ 2 + b ^ 2 := by

