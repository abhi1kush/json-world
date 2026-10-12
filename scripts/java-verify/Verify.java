import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.JavaType;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.Iterator;
import java.util.List;
import java.util.Map;

/** For each case: JSON -> generated class (Jackson) -> JSON, then compare trees. */
public class Verify {
    static JsonNode stripNulls(JsonNode n) {
        if (n.isObject()) {
            ObjectNode o = ((ObjectNode) n).deepCopy();
            Iterator<Map.Entry<String, JsonNode>> it = o.fields();
            while (it.hasNext()) { Map.Entry<String, JsonNode> e = it.next(); if (e.getValue().isNull()) it.remove(); }
            o.fields().forEachRemaining(e -> o.set(e.getKey(), stripNulls(e.getValue())));
            return o;
        }
        if (n.isArray()) {
            var a = n.deepCopy();
            for (int i = 0; i < a.size(); i++) ((com.fasterxml.jackson.databind.node.ArrayNode) a).set(i, stripNulls(a.get(i)));
            return a;
        }
        return n;
    }
    /** Numbers compare by value (3 == 3.0, BigInteger == Long); everything else by equals. */
    static final Comparator<JsonNode> NUMERIC = (x, y) -> {
        if (x.isNumber() && y.isNumber()) return x.decimalValue().compareTo(y.decimalValue());
        return x.equals(y) ? 0 : 1;
    };
    public static void main(String[] args) throws Exception {
        ObjectMapper mapper = new ObjectMapper();
        int pass = 0, fail = 0, strict = 0;
        for (String line : Files.readAllLines(Path.of(args[0]))) {
            if (line.isBlank()) continue;
            String[] p = line.split("\t");
            String cls = p[0], file = p[1]; boolean array = p[2].equals("array"); boolean ignoreUnknown = p[3].equals("ignoreUnknown");
            String label = cls.replace("verify.", "").replace(".Request", "");
            try {
                String json = Files.readString(Path.of(file));
                Class<?> c = Class.forName(cls);
                JavaType t = array ? mapper.getTypeFactory().constructCollectionType(List.class, c) : mapper.constructType(c);
                Object value = mapper.readValue(json, t);
                String back = mapper.writeValueAsString(value);
                JsonNode a = mapper.readTree(json), b = mapper.readTree(back);
                boolean eqStrict = a.equals(b);
                boolean eqNum = eqStrict || a.equals(NUMERIC, b);
                boolean eq = eqNum || stripNulls(a).equals(NUMERIC, stripNulls(b));
                if (ignoreUnknown && !array) {
                    ObjectNode extra = ((ObjectNode) a).deepCopy(); extra.put("__unknown_property__", 1);
                    mapper.readValue(mapper.writeValueAsString(extra), t); // must not throw
                }
                if (eq) { pass++; if (eqStrict) strict++; System.out.println("PASS " + label + (eqStrict ? " (identical)" : eqNum ? " (identical by numeric value)" : " (equal; merged-class fields absent in input serialize as null)") + (ignoreUnknown ? " +ignoreUnknown" : "")); }
                else { fail++; System.out.println("FAIL " + label + "\n  in : " + a + "\n  out: " + b); }
            } catch (Throwable e) {
                fail++; System.out.println("FAIL " + label + " " + e);
            }
        }
        System.out.println("\n" + pass + " passed (" + strict + " byte-for-byte identical trees), " + fail + " failed");
        System.exit(fail == 0 ? 0 : 1);
    }
}
