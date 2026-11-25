/**
 * Login rate-limit fail-open behaviour (no live D1 required).
 */
import { isLoginBlocked, recordLoginAttempt, extractClientIp } from "../src/lib/rateLimit.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

/** Mock DB that throws on any prepare (simulates missing login_attempts). */
function throwingDb() {
  return {
    prepare() {
      throw new Error("D1_ERROR: no such table: login_attempts");
    }
  };
}

/** Mock DB that returns configurable counts. */
function countingDb({ userFails = 0, ipFails = 0 } = {}) {
  return {
    prepare(sql) {
      const s = String(sql);
      return {
        bind() {
          return this;
        },
        async first() {
          if (s.includes("username_key")) return { c: userFails };
          if (s.includes("WHERE ip")) return { c: ipFails };
          return { c: 0 };
        },
        async run() {
          return { success: true };
        }
      };
    }
  };
}

async function main() {
  let passed = 0;

  {
    const r = await isLoginBlocked(throwingDb(), "validuser", "1.2.3.4");
    assert(r.blocked === false, "missing table should fail-open");
    assert(r.degraded === true, "should mark degraded");
    passed++;
  }

  {
    const r = await isLoginBlocked(countingDb({ userFails: 4, ipFails: 10 }), "u", "1.1.1.1");
    assert(r.blocked === false, "4 fails should not block");
    passed++;
  }

  {
    const r = await isLoginBlocked(countingDb({ userFails: 5 }), "u", null);
    assert(r.blocked === true, "5 user fails should block");
    passed++;
  }

  {
    const r = await isLoginBlocked(countingDb({ userFails: 0, ipFails: 20 }), "u", "9.9.9.9");
    assert(r.blocked === true, "20 IP fails should block");
    passed++;
  }

  {
    await recordLoginAttempt(throwingDb(), "u", "1.1.1.1", false);
    passed++;
  }

  {
    const req = {
      headers: {
        get(n) {
          if (n === "CF-Connecting-IP") return "203.0.113.10";
          if (n === "X-Forwarded-For") return "1.1.1.1";
          return null;
        }
      }
    };
    assert(extractClientIp(req) === "203.0.113.10", "must use CF-Connecting-IP");
    passed++;
  }

  console.log(`ok ${passed} assertions`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
