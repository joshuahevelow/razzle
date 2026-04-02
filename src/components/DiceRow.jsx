export default function DiceRow({ dice }) {
  return (
    <div className="dice-row">
      {dice.map((d, i) => (
        <div key={i} className="dice-tile">
          {d}
        </div>
      ))}
    </div>
  );
}
