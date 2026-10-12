import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

/**
 * Usage: LoadProps load <file> <latin1|utf8>   -> prints every loaded entry as a JSON-escaped "key"\t"value" line (sorted)
 *        LoadProps store <tsv-in> <file-out>   -> reads JSON-escaped key/value lines, writes them with Properties.store
 */
public class LoadProps {
  static String q(String s) {
    StringBuilder b = new StringBuilder("\"");
    for (char c : s.toCharArray()) {
      if (c == '"' || c == '\\') b.append('\\').append(c);
      else if (c < 0x20 || c > 0x7e) b.append(String.format("\\u%04x", (int) c));
      else b.append(c);
    }
    return b.append('"').toString();
  }
  public static void main(String[] a) throws Exception {
    Properties p = new Properties();
    if (a[0].equals("load")) {
      if (a[2].equals("latin1")) try (InputStream in = new FileInputStream(a[1])) { p.load(in); }
      else try (Reader r = Files.newBufferedReader(Paths.get(a[1]), StandardCharsets.UTF_8)) { p.load(r); }
      for (String k : new TreeSet<>(p.stringPropertyNames())) System.out.println(q(k) + "\t" + q(p.getProperty(k)));
    } else {
      // input lines: key<TAB>value, both given as \\uXXXX-escaped ASCII (decoded here)
      for (String line : Files.readAllLines(Paths.get(a[1]), StandardCharsets.UTF_8)) {
        if (line.isEmpty()) continue;
        String[] kv = line.split("\t", -1);
        p.setProperty(dec(kv[0]), dec(kv[1]));
      }
      try (OutputStream out = new FileOutputStream(a[2])) { p.store(out, "written by java.util.Properties.store"); }
    }
  }
  static String dec(String s) {
    StringBuilder b = new StringBuilder();
    for (int i = 0; i < s.length(); i++) {
      if (s.charAt(i) == '\\' && s.charAt(i + 1) == 'u') { b.append((char) Integer.parseInt(s.substring(i + 2, i + 6), 16)); i += 5; }
      else b.append(s.charAt(i));
    }
    return b.toString();
  }
}
