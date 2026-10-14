;; SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
;; SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
;; SPDX-FileCopyrightText: Copyright Contributors to the Sentin8:E2E
;; SPDX-License-Identifier: Apache-2.0

(module
  (memory (export "memory") 1)
  (func (export "run") (result i32)
    i32.const 42
  )
  ;; Hook export required by the func upload validator — the declared
  ;; `hooks` list must match the module's exports (runtime.rs validate()).
  (func (export "pre_posting") (result i32)
    i32.const 1
  )
)
