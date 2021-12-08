if  [ ! "$1" ] ;then
    date=$(date "+%Y-%m-%d %H:%M:%S")
    echo "you have not input a word$date"
else
    echo "the word you input is $1"
fi
