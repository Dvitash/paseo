import type { StyleProp, TextStyle, ViewStyle } from "react-native";

export interface MathProps {
  latex: string;
  style?: StyleProp<TextStyle | ViewStyle>;
}
