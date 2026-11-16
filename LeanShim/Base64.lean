/-
`from_base64 "<base64>"` — decode a standard Base64 string to Lean 4 tactic source and run it.

The Lean Proof Fill VS Code extension writes proofs it has verified in this encoded form, so the
source text of the proof is not shown in the file. Decoding happens at elaboration time: the proof
is still fully checked by Lean, exactly as if the tactics were written out.
-/
import Lean
open Lean Elab Tactic

namespace LeanShim.Base64

/-- Value of a standard Base64 alphabet character; `none` for padding/invalid characters. -/
private def dval (c : Char) : Option Nat :=
  let n := c.toNat
  if 'A'.toNat ≤ n && n ≤ 'Z'.toNat then some (n - 'A'.toNat)
  else if 'a'.toNat ≤ n && n ≤ 'z'.toNat then some (n - 'a'.toNat + 26)
  else if '0'.toNat ≤ n && n ≤ '9'.toNat then some (n - '0'.toNat + 52)
  else if c == '+' then some 62
  else if c == '/' then some 63
  else none

/-- Decode a standard Base64 string to bytes. ASCII whitespace is ignored; `=` is padding. -/
def decodeBytes (s : String) : Except String (Array UInt8) := Id.run do
  let mut quad : Array Nat := #[]
  let mut out : Array UInt8 := #[]
  let mut pad := 0
  for c in s.toList do
    if c == '=' then
      pad := pad + 1
      quad := quad.push 0
    else if c == ' ' || c == '\n' || c == '\r' || c == '\t' then
      pure ()
    else
      match dval c with
      | none => return .error s!"invalid base64 character '{c}'"
      | some v => quad := quad.push v
    if quad.size == 4 then
      let n := (quad[0]! <<< 18) ||| (quad[1]! <<< 12) ||| (quad[2]! <<< 6) ||| quad[3]!
      out := out.push (UInt8.ofNat ((n >>> 16) &&& 0xff))
      if pad < 2 then out := out.push (UInt8.ofNat ((n >>> 8) &&& 0xff))
      if pad < 1 then out := out.push (UInt8.ofNat (n &&& 0xff))
      quad := #[]
  if quad.size != 0 then return .error "base64 length is not a multiple of 4"
  return .ok out

/-- Decode a standard Base64 string to a UTF-8 `String`. -/
def decode (s : String) : Except String String := do
  let bytes ← decodeBytes s
  match String.fromUTF8? ⟨bytes⟩ with
  | some str => .ok str
  | none => .error "decoded bytes are not valid UTF-8"

/--
`from_base64 "<base64>"` decodes the Base64 string to Lean tactic source and runs it as if those
tactics had been written in place. The decoded tactics are wrapped in parentheses and run as one
tactic block, so the whole proof must close the goals it is given.
-/
elab "from_base64 " s:str : tactic => do
  match decode s.getString with
  | .error e => throwError "from_base64: {e}"
  | .ok src =>
    -- Wrap in parentheses so a multi-tactic sequence parses as a single tactic.
    match Parser.runParserCategory (← getEnv) `tactic ("(\n" ++ src ++ "\n)") "<from_base64>" with
    | .error e => throwError "from_base64: could not parse the decoded tactics:\n{e}"
    | .ok stx => evalTactic stx

end LeanShim.Base64
