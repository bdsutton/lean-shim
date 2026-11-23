import Mathlib.Basic.Real.Basic
--import Mathlib.Algebra.Order.Archimedean.Real.Basic
import Mathlib.NumberTheory.Real.Irrational
--import Mathlib.Tactic.Ring
--import Mathlib.Tactic.Linarith
--import Mathlib.Tactic.NormNum
--import Mathlib.Tactic.Positivity
--import Mathlib.Tactic.FieldSimp
import Mathlib.Tactic.Push
--import Mathlib.Tactic.Tauto
--import Mathlib.Tactic.Common
import Mathlib.Topology.MetricSpace.Basic

open Set

-- Definition. A *neighborhood* of a point x₀ in a
-- metric space S is a set
--   Nᵣ(x₀) = { x ∈ S | dist(x, x₀) < r }
-- for some radius r. Ross requires r > 0, but the
-- usual approach in Lean is to omit this from the
-- definition and instead impose r > 0 in theorems.
def Neighborhood {S} [MetricSpace S]
    (x₀ : S) (r : ℝ) : Set S :=
  { x : S | dist x x₀ < r }

-- Definition. A point x₀ is *interior to* a set E if
-- there exists a neighborhood of positive radius
-- around x₀ that is entirely contained within E.
def IsInteriorTo {S} [MetricSpace S]
    (x₀ : S) (E : Set S) : Prop :=
  ∃ r : ℝ, r > 0 ∧ (Neighborhood x₀ r) ⊆ E

-- Definition. The *interior* of a set E is the set of
-- all its interior points.
def Interior {S} [MetricSpace S] (E : Set S) : Set S :=
  { x : S | IsInteriorTo x E }

-- Theorem. The left endpoint of any closed interval
-- [a, b] is not interior to the interval.
theorem left_endpoint_of_Icc_is_not_interior
    (a : ℝ) (b : ℝ) : ¬(IsInteriorTo a (Icc a b)) := by
  -- We need to show that no neighborhood of a is
  -- entirely contained in [a, b].
  unfold IsInteriorTo
  push Not
  -- Let r > 0.
  intro r hr
  -- We need to find an x ∈ Nᵣ(a) that is not a subset
  -- of [a, b].
  suffices ∃ x : ℝ, x ∈ Neighborhood a r ∧ x ∉ Icc a b   by intro hsub; rcases this with ⟨x, hx, hnx⟩; exact hnx (hsub hx)
  -- Let x = a - r / 2.
  let x := a - r / 2
  -- x is in Nᵣ(a),
  have : x ∈ Neighborhood a r                            := by change |(a - r / 2) - a| < r; rw [abs_lt]; constructor <;> linarith
  -- but x ∉ [a, b].
  have : x ∉ Icc a b                                     := by intro hx; (have hlt : x < a := by dsimp [x]; linarith); exact (not_le_of_gt hlt) hx.1
  use x

-- Definition. A set E is *open* if every point in E is
-- interior.
def IsOpen421 {S} [MetricSpace S] (E : Set S) :=
  ∀ x ∈ E, IsInteriorTo x E

-- Definition. A set E is *closed* if its complement is
-- open.
def IsClosed421 {S} [MetricSpace S] (E : Set S) :=
  IsOpen421 Eᶜ

-- Theorem. The union of a collection of open sets is
-- open.
theorem union_of_collection_of_open_is_open
    {S} [MetricSpace S]
    (C : Set (Set S)) (hopen : ∀ E ∈ C, IsOpen421 E)
    : IsOpen421 (⋃₀ C) := by
  -- We need to show that every element of the union is
  -- interior.
  unfold IsOpen421
  -- Let x be an element of the union.
  intro x hx
  -- x belongs to some set E₁ in the collection of open
  -- sets.
  have hexistsE₁: ∃ E₁ ∈ C, x ∈ E₁                       := by rcases mem_sUnion.mp hx with ⟨E, hE, hxE⟩; exact ⟨E, hE, hxE⟩
  obtain ⟨E₁, hE₁⟩ := hexistsE₁
  -- Because E₁ is open, there exists a neighborhood
  -- Nᵣ(x) ⊆ E₁.
  have : IsOpen421 E₁                                    := by exact (‹∀ E ∈ C, IsOpen421 E› E₁ hE₁.1)
  have hexistsr: ∃ r > 0, Neighborhood x r ⊆ E₁          := by exact this x hE₁.2
  obtain ⟨r, hr⟩ := hexistsr
  -- Because Nᵣ(x) ⊆ E₁ ⊆ ⋃ C, we've shown that x is
  -- interior to ⋃ C.
  have : Neighborhood x r ⊆ ⋃₀ C                         := by intro y hy; simp only [Set.mem_sUnion]; exact ⟨E₁, hE₁.1, hr.2 hy⟩
  .                                                      exact ⟨r, hr.1, this⟩
