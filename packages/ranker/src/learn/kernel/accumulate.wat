;; The Newton-step accumulation of `fitLogistic` (spec 06 §8.3, D-264) with 128-bit SIMD.
;;
;; accumulate(n, m, a, r, h, g, H): for every row i of the n × m design `a` (row-major f64), with
;; that row's residual r[i] and curvature h[i]:
;;   g[j]      += r[i] · a[i][j]               (j = 0 … m−1)
;;   H[j][k]   += (h[i] · a[i][j]) · a[i][k]   (k = 0 … j, the lower triangle)
;; Pointers are byte offsets into this module's memory; every array is little-endian f64.
;;
;; Bit-identical to the JS loop it replaces: each g[j] and H[j][k] is still a sum over the rows in
;; row order, and the two lanes of an f64x2 are two different H entries (k, k+1), never a reduction.
;; f64x2.mul and f64x2.add round each lane exactly like f64.mul and f64.add; there is no fused
;; multiply-add (relaxed SIMD is never used). Regenerate the embedded bytes with
;; `pnpm --filter @bantoozi/ranker kernel:gen` after any edit.
(module
  (memory (export "memory") 1)
  (func (export "accumulate")
    (param $n i32) (param $m i32) (param $a i32) (param $r i32) (param $h i32)
    (param $g i32) (param $H i32)
    (local $i i32) (local $j i32) (local $k i32) (local $count i32)
    (local $row i32) (local $hrow i32) (local $rowBytes i32)
    (local $ri f64) (local $hi f64) (local $aj f64) (local $hj f64) (local $hjv v128)
    (local.set $rowBytes (i32.shl (local.get $m) (i32.const 3)))
    (local.set $i (i32.const 0))
    (block $rowsDone
      (loop $rows
        (br_if $rowsDone (i32.ge_u (local.get $i) (local.get $n)))
        (local.set $ri (f64.load (i32.add (local.get $r) (i32.shl (local.get $i) (i32.const 3)))))
        (local.set $hi (f64.load (i32.add (local.get $h) (i32.shl (local.get $i) (i32.const 3)))))
        (local.set $row (i32.add (local.get $a) (i32.mul (local.get $i) (local.get $rowBytes))))
        (local.set $j (i32.const 0))
        (block $colsDone
          (loop $cols
            (br_if $colsDone (i32.ge_u (local.get $j) (local.get $m)))
            (local.set $aj (f64.load (i32.add (local.get $row) (i32.shl (local.get $j) (i32.const 3)))))
            ;; g[j] = g[j] + r[i] · a[i][j]
            (f64.store
              (i32.add (local.get $g) (i32.shl (local.get $j) (i32.const 3)))
              (f64.add
                (f64.load (i32.add (local.get $g) (i32.shl (local.get $j) (i32.const 3))))
                (f64.mul (local.get $ri) (local.get $aj))))
            (local.set $hj (f64.mul (local.get $hi) (local.get $aj)))
            (local.set $hjv (f64x2.splat (local.get $hj)))
            (local.set $hrow (i32.add (local.get $H) (i32.mul (local.get $j) (local.get $rowBytes))))
            (local.set $count (i32.add (local.get $j) (i32.const 1)))
            (local.set $k (i32.const 0))
            ;; H[j][k, k+1] += hj · a[i][k, k+1] while both entries are in the triangle
            (block $pairsDone
              (loop $pairs
                (br_if $pairsDone (i32.gt_u (i32.add (local.get $k) (i32.const 2)) (local.get $count)))
                (v128.store
                  (i32.add (local.get $hrow) (i32.shl (local.get $k) (i32.const 3)))
                  (f64x2.add
                    (v128.load (i32.add (local.get $hrow) (i32.shl (local.get $k) (i32.const 3))))
                    (f64x2.mul
                      (local.get $hjv)
                      (v128.load (i32.add (local.get $row) (i32.shl (local.get $k) (i32.const 3)))))))
                (local.set $k (i32.add (local.get $k) (i32.const 2)))
                (br $pairs)))
            ;; the odd last entry of the row, when j + 1 is odd
            (if (i32.lt_u (local.get $k) (local.get $count))
              (then
                (f64.store
                  (i32.add (local.get $hrow) (i32.shl (local.get $k) (i32.const 3)))
                  (f64.add
                    (f64.load (i32.add (local.get $hrow) (i32.shl (local.get $k) (i32.const 3))))
                    (f64.mul
                      (local.get $hj)
                      (f64.load (i32.add (local.get $row) (i32.shl (local.get $k) (i32.const 3)))))))))
            (local.set $j (i32.add (local.get $j) (i32.const 1)))
            (br $cols)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $rows)))))
